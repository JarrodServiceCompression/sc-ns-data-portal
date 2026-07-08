'use strict';

const { app } = require('@azure/functions');
const crypto = require('crypto');
const sql = require('mssql');
const { DefaultAzureCredential } = require('@azure/identity');

// ---------------------------------------------------------------------------
// Config-driven ingestion: adding a source is a one-line change.
// Start with the asset saved search; others are commented out.
// ---------------------------------------------------------------------------
const SEARCHES = [
  { searchID: process.env.NETSUITE_ASSET_SEARCH_ID, tableName: 'assets' },
  // { searchID: 'customsearch214360', tableName: 'make_ready' },   // Make Ready
  // { searchID: 'customsearch214761', tableName: 'weekly_set' },   // Weekly Set
];

// ---------------------------------------------------------------------------
// OAuth 1.0a Token-Based Auth, HMAC-SHA256 (reused verbatim in spirit from the
// Nexus ops portal: netsuite.js). HMAC-SHA256 is hardcoded on purpose. The JSON
// body is intentionally NOT folded into the signature base string; realm is the
// NetSuite account id, spliced into the Authorization header manually.
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

  // Query-string params (script, deploy, ...) MUST be part of the signature base.
  const u = new URL(urlStr);
  const sigParams = { ...oauth };
  for (const [k, v] of u.searchParams) sigParams[k] = v;

  const normalized = Object.keys(sigParams)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(sigParams[k])}`)
    .join('&');

  const baseUrl = `${u.origin}${u.pathname}`;
  const baseString = [method.toUpperCase(), rfc3986(baseUrl), rfc3986(normalized)].join('&');
  const signingKey = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  const header =
    `OAuth realm="${creds.accountId}", ` +
    Object.keys(oauth)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(oauth[k])}"`)
      .join(', ');
  return header;
}

function readCreds() {
  const required = [
    'NETSUITE_ACCOUNT_ID', 'NETSUITE_CONSUMER_KEY', 'NETSUITE_CONSUMER_SECRET',
    'NETSUITE_TOKEN_ID', 'NETSUITE_TOKEN_SECRET', 'NETSUITE_RESTLET_URL',
  ];
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

// NetSuite list-typed fields come back as { value, text }. Coerce to plain text.
function coerce(v) {
  if (v && typeof v === 'object' && ('text' in v || 'value' in v)) {
    return v.text != null ? v.text : v.value;
  }
  return v;
}

// Pick the first present key (case-insensitive-ish) from a row.
function pick(row, keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') return coerce(row[k]);
    const found = Object.keys(row).find((rk) => rk.toLowerCase() === k.toLowerCase());
    if (found && row[found] != null && row[found] !== '') return coerce(row[found]);
  }
  return null;
}

async function runSavedSearch(searchID, creds, log) {
  const method = 'POST';
  const authHeader = buildAuthHeader(method, creds.restletUrl, creds);
  const res = await fetch(creds.restletUrl, {
    method,
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
    : Array.isArray(data.data) ? data.data
    : [];
  log(`RESTlet returned ${rows.length} rows for search ${searchID}`);
  return rows;
}

async function sqlConnect() {
  // Managed-identity auth to Azure SQL (no password anywhere).
  const cred = new DefaultAzureCredential();
  const token = await cred.getToken('https://database.windows.net/.default');
  return sql.connect({
    server: process.env.SQL_SERVER,          // e.g. sql-sc-nsportal.database.windows.net
    database: process.env.SQL_DATABASE,      // scnsdata
    options: { encrypt: true },
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: token.token },
    },
  });
}

async function landRows(pool, tableName, rows, log) {
  if (tableName !== 'assets') {
    // Only the assets table is modeled so far; extend here as searches are added.
    log(`No table mapping for ${tableName}; skipping insert.`);
    return 0;
  }
  let inserted = 0;
  for (const row of rows) {
    const req = pool.request();
    req.input('unit_name', sql.NVarChar(64), pick(row, ['name', 'unit', 'unitNumber', 'assetName', 'custrecord_asset_number']));
    req.input('status', sql.NVarChar(128), pick(row, ['status', 'unitStatus', 'fleetStatus', 'custrecord5']));
    req.input('region', sql.NVarChar(128), pick(row, ['region', 'basin', 'area', 'location']));
    req.input('customer', sql.NVarChar(256), pick(row, ['customer', 'entity', 'company', 'customerName']));
    req.input('engine_make', sql.NVarChar(128), pick(row, ['engineMake', 'engine_make', 'make']));
    req.input('engine_model', sql.NVarChar(128), pick(row, ['engineModel', 'engine_model', 'model']));
    req.input('horsepower', sql.NVarChar(64), pick(row, ['horsepower', 'hp', 'engineHp']));
    req.input('driver_type', sql.NVarChar(64), pick(row, ['driverType', 'driver_type', 'driver']));
    req.input('pm_cycle_days', sql.NVarChar(32), pick(row, ['pmCycle', 'pmCycleDays', 'pm_cycle_days']));
    req.input('raw_payload', sql.NVarChar(sql.MAX), JSON.stringify(row));
    await req.query(`
      INSERT INTO dbo.assets
        (unit_name, status, region, customer, engine_make, engine_model, horsepower, driver_type, pm_cycle_days, raw_payload)
      VALUES
        (@unit_name, @status, @region, @customer, @engine_make, @engine_model, @horsepower, @driver_type, @pm_cycle_days, @raw_payload)
    `);
    inserted++;
  }
  log(`Inserted ${inserted} rows into dbo.${tableName} (stamped loaded_at).`);
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
