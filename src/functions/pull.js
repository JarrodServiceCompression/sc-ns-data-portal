'use strict';

const { app } = require('@azure/functions');
const crypto = require('crypto');
const sql = require('mssql');
const { DefaultAzureCredential } = require('@azure/identity');

// ---------------------------------------------------------------------------
// Config-driven ingestion: adding a source is a one-line change.
// ---------------------------------------------------------------------------
const SEARCHES = [
  { searchID: process.env.NETSUITE_ASSET_SEARCH_ID, tableName: 'assets' },
  // { searchID: 'customsearch214360', tableName: 'make_ready' },   // Make Ready
  // { searchID: 'customsearch214761', tableName: 'weekly_set' },   // Weekly Set
];

// Columns the loader manages itself — never treated as data fields.
const RESERVED = new Set(['row_id', 'loaded_at', 'raw_payload']);

// ---------------------------------------------------------------------------
// OAuth 1.0a Token-Based Auth, HMAC-SHA256 (reused from the Nexus ops portal).
// ---------------------------------------------------------------------------
function rfc3986(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildAuthHeader(method, urlStr, creds) {
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.tokenId,
    oauth_version: '1.0',
  };
  const u = new URL(urlStr);
  const sigParams = { ...oauth };
  for (const [k, v] of u.searchParams) sigParams[k] = v;
  const normalized = Object.keys(sigParams).sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(sigParams[k])}`).join('&');
  const baseUrl = `${u.origin}${u.pathname}`;
  const baseString = [method.toUpperCase(), rfc3986(baseUrl), rfc3986(normalized)].join('&');
  const signingKey = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');
  return `OAuth realm="${creds.accountId}", ` +
    Object.keys(oauth).sort().map((k) => `${rfc3986(k)}="${rfc3986(oauth[k])}"`).join(', ');
}

function readCreds() {
  const required = ['NETSUITE_ACCOUNT_ID', 'NETSUITE_CONSUMER_KEY', 'NETSUITE_CONSUMER_SECRET',
    'NETSUITE_TOKEN_ID', 'NETSUITE_TOKEN_SECRET', 'NETSUITE_RESTLET_URL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing NetSuite settings: ${missing.join(', ')}`);
  return {
    accountId: process.env.NETSUITE_ACCOUNT_ID,
    consumerKey: process.env.NETSUITE_CONSUMER_KEY,
    consumerSecret: process.env.NETSUITE_CONSUMER_SECRET,
    tokenId: process.env.NETSUITE_TOKEN_ID,
    tokenSecret: process.env.NETSUITE_TOKEN_SECRET,
    restletUrl: process.env.NETSUITE_RESTLET_URL,
  };
}

// Coerce any NetSuite value (incl. { value, text } list fields and arrays) to text.
function toText(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    if (!Array.isArray(v) && ('text' in v || 'value' in v)) {
      return v.text != null ? String(v.text) : (v.value != null ? String(v.value) : null);
    }
    return JSON.stringify(v);
  }
  return String(v);
}

// NetSuite saved-search rows serialize as { id, recordType, values: { field: ... } }.
// Flatten so every field in `values` becomes a top-level column, alongside id/recordType.
function flattenRow(row) {
  const out = {};
  if (row && typeof row === 'object') {
    for (const [k, v] of Object.entries(row)) {
      if (k === 'values' && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [vk, vv] of Object.entries(v)) out[vk] = vv;
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

// Sanitize a NetSuite field key into a safe, stable SQL column name.
function colName(key) {
  let c = String(key).replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 120);
  if (!c) c = 'col';
  if (/^[0-9]/.test(c)) c = 'c_' + c;
  return c.toLowerCase();
}

async function runSavedSearch(searchID, creds, log) {
  const authHeader = buildAuthHeader('POST', creds.restletUrl, creds);
  const res = await fetch(creds.restletUrl, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchID }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`NetSuite RESTlet ${res.status}: ${text.slice(0, 500)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON RESTlet response: ${text.slice(0, 300)}`); }
  const rows = Array.isArray(data) ? data
    : Array.isArray(data.rows) ? data.rows
    : Array.isArray(data.results) ? data.results
    : Array.isArray(data.data) ? data.data : [];
  log(`RESTlet returned ${rows.length} rows for search ${searchID}`);
  if (rows.length) log(`Sample raw row: ${JSON.stringify(rows[0]).slice(0, 900)}`);
  return rows;
}

async function sqlConnect() {
  const cred = new DefaultAzureCredential();
  const token = await cred.getToken('https://database.windows.net/.default');
  return sql.connect({
    server: process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE,
    options: { encrypt: true },
    authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
  });
}

async function ensureColumns(pool, tableName, cols, log) {
  const existing = new Set();
  const res = await pool.request().query(
    `SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID('dbo.${tableName}')`);
  for (const r of res.recordset) existing.add(r.name.toLowerCase());
  let added = 0;
  for (const col of cols) {
    if (existing.has(col) || RESERVED.has(col)) continue;
    await pool.request().query(`ALTER TABLE dbo.${tableName} ADD [${col}] NVARCHAR(MAX) NULL`);
    added++;
  }
  if (added) log(`Added ${added} new column(s) to dbo.${tableName} for the full field set.`);
}

async function landRows(pool, tableName, rows, log) {
  if (!rows.length) return 0;

  // Flatten every row, then build the union of all field columns.
  const flat = rows.map(flattenRow);
  const colMap = new Map(); // sanitized column -> original key
  for (const rec of flat) {
    for (const key of Object.keys(rec)) {
      const col = colName(key);
      if (!RESERVED.has(col) && !colMap.has(col)) colMap.set(col, key);
    }
  }
  const cols = [...colMap.keys()];
  await ensureColumns(pool, tableName, cols, log);
  log(`Loading ${cols.length} data columns: ${cols.slice(0, 40).join(', ')}${cols.length > 40 ? ', …' : ''}`);

  let inserted = 0;
  for (let i = 0; i < flat.length; i++) {
    const rec = flat[i];
    const req = pool.request();
    const colList = [];
    const valList = [];
    cols.forEach((col, j) => {
      const p = `p${j}`;
      req.input(p, sql.NVarChar(sql.MAX), toText(rec[colMap.get(col)]));
      colList.push(`[${col}]`);
      valList.push(`@${p}`);
    });
    req.input('raw_payload', sql.NVarChar(sql.MAX), JSON.stringify(rows[i]));
    colList.push('[raw_payload]');
    valList.push('@raw_payload');
    await req.query(`INSERT INTO dbo.${tableName} (${colList.join(',')}) VALUES (${valList.join(',')})`);
    inserted++;
  }
  log(`Inserted ${inserted} rows into dbo.${tableName} across ${cols.length} data columns (stamped loaded_at).`);
  return inserted;
}

async function runPull(log) {
  const creds = readCreds();
  const summary = [];
  const pool = await sqlConnect();
  try {
    for (const s of SEARCHES) {
      if (!s.searchID) { log(`Skipping ${s.tableName}: no searchID configured.`); continue; }
      const rows = await runSavedSearch(s.searchID, creds, log);
      const inserted = await landRows(pool, s.tableName, rows, log);
      summary.push({ table: s.tableName, fetched: rows.length, inserted });
    }
  } finally {
    await pool.close();
  }
  return summary;
}

app.http('pull', {
  methods: ['GET', 'POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const log = (m) => context.log(m);
    try {
      const summary = await runPull(log);
      return { status: 200, jsonBody: { ok: true, summary } };
    } catch (err) {
      context.error(err);
      return { status: 500, jsonBody: { ok: false, error: String(err && err.message || err) } };
    }
  },
});

app.timer('dailyPull', {
  schedule: '0 0 6 * * *',
  handler: async (myTimer, context) => {
    const log = (m) => context.log(m);
    try {
      const summary = await runPull(log);
      context.log('Daily pull complete: ' + JSON.stringify(summary));
    } catch (err) {
      context.error('Daily pull failed:', err);
      throw err;
    }
  },
});
