# STATE — where the build stands right now

*The living "where things stand" file. Any fresh Cowork should be able to read this top-to-bottom and know exactly what exists, what's next, and what to be careful about. Updated after every step.*

**As of:** repo bootstrap (Step 1 of 7)
**Owner:** Jarrod Smith · Service Compression
**Repo:** `JarrodServiceCompression/sc-ns-data-portal` (public — code + markdown only)

---

## Where we are

| # | Step | Status |
|---|------|--------|
| 1 | Public repo + docs skeleton | ✅ in progress (this commit) |
| 2 | NetSuite asset-search pull (reuse Nexus RESTlet) | ⬜ next |
| 3 | Fresh Azure SQL + schema, land rows | ⬜ |
| 4 | Timer-triggered Function (daily pull) | ⬜ |
| 5 | React + Vite viz app (Static Web App) | ⬜ |
| 6 | Live change → push → deploy → green | ⬜ |
| 7 | Centerpiece: fresh Cowork reads this repo | ⬜ |

## The architecture in one line

NetSuite saved search → (RESTlet, OAuth 1.0a TBA, HMAC-SHA256) → Azure Function → Azure SQL → React+Vite viz app. Daily unattended refresh. Snapshot-append (every row stamped `loaded_at`), never overwrite.

## Planned Azure footprint (this build)

| Thing | Name |
|---|---|
| Resource group | `rg-sc-nsdata-portal` (new, isolated, tearable) |
| SQL server | `sql-sc-nsportal` |
| SQL database | `scnsdata` |
| Function App | `func-sc-nsportal` |
| Static Web App | `swa-sc-nsportal` |
| Subscription | `77309c4d-…` (Service Compression) |

Reuse donor: Nexus (`sc-ops-portal`) — NetSuite integration + deploy-workflow pattern. Do **not** edit Nexus live.

## Guardrails (respect these)

- **Secrets:** NetSuite creds via Key Vault reference to `kv-sc-nexus-scl`. Never in Git, never pasted into files.
- **No data in Git:** fleet rows live only in Azure SQL.
- **Snapshot, don't replace:** append rows stamped `loaded_at` so history survives.
- **NetSuite list fields** return `{value, text}` — coerce before storing/charting.
- **Config-driven ingestion:** add/swap saved searches via an array of `{ searchID, tableName }` — one-line change.

## What to do next

Step 2 — build the pull: reuse the Nexus OAuth 1.0a TBA + RESTlet `script=1433 deploy=1`, run the asset saved search, confirm real fleet rows come back. Details in [`docs/netsuite-config.md`](./docs/netsuite-config.md).
