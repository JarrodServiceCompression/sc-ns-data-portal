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
// HMAC-SHA256 hardcoded on purpose; the JSON body is NOT folded into the
// signature base string; realm is the NetSuite account id.
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

// NetSuite list-typed fields come back as { value, text }. Coerce anything to text.
function toText(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('text' in v || 'value' in v) return v.text != null ? String(v.text) : (v.value != null ? String(v.value) : null);
    return JSON.stringify(v);
  }
  return String(v);
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

// Ensure the target table has a column for every field key seen in the rows.
async function ensureColumns(pool, tableName, colMap, log) {
  const existing = new Set();
  const res = await pool.request().query(
    `SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID('dbo.${tableName}')`);
  for (const r of res.recordset) existing.add(r.name.toLowerCase());

  let added = 0;
  for (const col of colMap.keys()) {
    if (existing.has(col) || RESERVED.has(col)) continue;
    // Column names are sanitized to [a-z0-9_]; safe to inline. Values are always parameterized.
    await pool.request().query(`ALTER TABLE dbo.${tableName} ADD [${col}] NVARCHAR(MAX) NULL`);
    added++;
  }
  if (added) log(`Added ${added} new column(s) to dbo.${tableName} for the full field set.`);
}

async function landRows(pool, tableName, rows, log) {
  if (!rows.length) return 0;

  // 1) Build the full set of columns across every row (search may vary row-to-row).
  const colMap = new Map(); // sanitized column -> original key (first seen wins)
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const col = colName(key);
      if (!RESERVED.has(col) && !colMap.has(col)) colMap.set(col, key);
    }
  }

  // 2) Make sure every column exists on the table (auto-provision).
  await ensureColumns(pool, tableName, colMap, log);

  // 3) Insert each row with ALL of its fields + the full raw payload.
  const cols = [...colMap.keys()];
  let inserted = 0;
  for (const row of rows) {
    const req = pool.request();
    const colList = [];
    const valList = [];
    cols.forEach((col, i) => {
      const p = `p${i}`;
      req.input(p, sql.NVarChar(sql.MAX), toText(row[colMap.get(col)]));
      colList.push(`[${col}]`);
      valList.push(`@${p}`);
    });
    req.input('raw_payload', sql.NVarChar(sql.MAX), JSON.stringify(row));
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

// HTTP trigger — invoke on demand (portal Test/Run or a GET to the function URL).
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

// Timer trigger — daily unattended refresh at 06:00 UTC. "Claude built it; Azure runs it."
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
