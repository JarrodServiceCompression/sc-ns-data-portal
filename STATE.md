# STATE — where the build stands right now

*The living "where things stand" file. Any fresh Cowork should be able to read this top-to-bottom and know exactly what exists, what's next, and what to be careful about. Updated after every step.*

**As of:** Azure infra provisioned + ingestion code committed; viz app is next.
**Owner:** Jarrod Smith · Service Compression
**Repo:** `JarrodServiceCompression/sc-ns-data-portal` (public — code + markdown only)

---

## Where we are

| # | Step | Status |
|---|------|--------|
| 1 | Public repo + docs skeleton | ✅ done |
| 2 | NetSuite asset-search pull (reuse Nexus RESTlet) | ✅ code written + committed (`src/functions/pull.js`); live run pending creds wiring |
| 3 | Fresh Azure SQL + schema, land rows | ✅ done — `assets` table live, 24-row representative snapshot loaded |
| 4 | Timer-triggered Function (daily pull) | ✅ Function App provisioned; deploy wiring (managed identity + Key Vault refs + OIDC) pending |
| 5 | React + Vite viz app (Static Web App) | ⬜ next |
| 6 | Live change → push → deploy → green | ⬜ |
| 7 | Centerpiece: fresh Cowork reads this repo | ⬜ |

## What is actually live in Azure (subscription `77309c4d-…`)

| Thing | Name | Notes |
|---|---|---|
| Resource group | `rg-sc-nsdata-portal` | new, isolated, tearable |
| SQL server | `sql-sc-nsportal` (Central US) | Microsoft Entra-only auth (no SQL password) |
| SQL database | `scnsdata` | General Purpose serverless, 1 vCore; `dbo.assets` table created |
| Function App | `func-sc-nsportal` (Canada Central) | Flex Consumption, Node 22; pull code committed, not yet deployed |
| Static Web App | `swa-sc-nsportal` | not created yet (Step 5) |

Asset saved search ID: **33382** (read from the Nexus App Service config).

## Current data

`dbo.assets` holds a **24-row representative snapshot** (On Rent 15 · Idle 5 · Make Ready 3 · New Build 1), shaped exactly like the real NetSuite asset pull, so the viz app and downstream can be built and demoed reliably. The **real** pull (`pull.js`) is ready to run once the Function's managed identity is granted Key Vault + SQL access and the deploy is wired.

## Guardrails (respect these)

- **Secrets:** NetSuite creds are referenced from Key Vault `kv-sc-nexus-scl` — never in Git, never typed into files, never handled by the assistant. `pull.js` reads them from env (Key Vault references).
- **No data in Git:** fleet rows live only in Azure SQL. The seed lives in the DB, not the repo.
- **Snapshot, don't replace:** every row stamped `loaded_at`.
- **NetSuite list fields** return `{value, text}` — `pull.js` coerces before storing.
- **Config-driven ingestion:** `SEARCHES` array in `pull.js` — add a source in one line.

## What to do next

Step 5 — build the React + Vite viz app (`swa-sc-nsportal`, `VITE_DEV_MODE=true`): one chart (units by status/region), one KPI card, one group-by table, reading the asset snapshot. Then Step 6 (push→deploy→green) and Step 7 (fresh-Cowork reads this repo).

Follow-up to fully close Step 2/4: enable the Function's system-assigned managed identity, grant it `Key Vault Secrets User` on `kv-sc-nexus-scl` and a contained DB user on `scnsdata` (db_datawriter), wire the OIDC deploy (Deployment Center), then run `pull` to land live rows.
