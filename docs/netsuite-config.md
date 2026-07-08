# NetSuite configuration

How the pull talks to NetSuite. The integration pattern is reused verbatim from the Nexus ops portal (`sc-ops-portal`, `backend/src/services/netsuite.js`).

## Auth

- **OAuth 1.0a Token-Based Auth (TBA)**, signature method **HMAC-SHA256** (hardcoded on purpose — a stale `NETSUITE_SIG_METHOD` env var once silently broke the Nexus pull).
- `realm="<ACCOUNT_ID>"` is spliced into the Authorization header manually.
- For JSON bodies, the body is intentionally **not** folded into the OAuth signature base string.
- REST host pattern: `https://<account>.suitetalk.api.netsuite.com`.

## The saved-search runner

- Custom **RESTlet**, `script=1433 deploy=1`, accepts `{ searchID }` and returns the search's rows.
- This is the exact mechanism reused here — point it at a saved-search ID, get rows back.

## Config-driven source list

Ingestion is driven by an array so adding a source is one line:

```js
const SEARCHES = [
  { searchID: process.env.NETSUITE_ASSET_SEARCH_ID, tableName: "assets" },
  // { searchID: "customsearch214360", tableName: "make_ready" },   // Make Ready
  // { searchID: "customsearch214761", tableName: "weekly_set" },   // Weekly Set
];
```

Known saved searches (from Nexus): asset search (`NETSUITE_ASSET_SEARCH_ID`), Make Ready `customsearch214360`, Weekly Set `customsearch214761`, Master Schedule `customsearch115549`.

## Required settings (in the Function, via Key Vault references)

`NETSUITE_ACCOUNT_ID`, `NETSUITE_CONSUMER_KEY`, `NETSUITE_CONSUMER_SECRET`, `NETSUITE_TOKEN_ID`, `NETSUITE_TOKEN_SECRET`, `NETSUITE_RESTLET_URL`, plus the search-ID vars. These already exist in **Key Vault `kv-sc-nexus-scl`** / the Nexus App Service settings — the Function references them so the values never enter Git or app-setting plaintext.

## Row handling

- **List-typed fields return `{ value, text }`** — coerce to the text (or value) you actually want before storing, or group-bys explode into objects.
- **Stamp `loaded_at`** on every row at insert time (snapshot-append).

## Record reference

Asset record type is `CUSTOMRECORD_F4N_ASSET`. Unit status is `custrecord5` (a list reference), not `custrecord_fa_status`.
