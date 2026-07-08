# Architecture

## Data flow

```
┌──────────────┐   OAuth 1.0a TBA (HMAC-SHA256)   ┌───────────────┐
│  NetSuite    │   RESTlet  script=1433 deploy=1   │ Azure Function│
│ saved search │ ────────────────────────────────▶ │ func-sc-      │
│ (asset)      │        rows: [{value,text}, …]     │ nsportal      │
└──────────────┘                                    └──────┬────────┘
                                                           │ INSERT (stamped loaded_at)
                                                           ▼
                                                    ┌───────────────┐
                                                    │  Azure SQL     │
                                                    │ sql-sc-nsportal│
                                                    │  db: scnsdata  │
                                                    └──────┬─────────┘
                                                           │ SELECT
                                                           ▼
                                                    ┌───────────────┐
                                                    │ React + Vite   │
                                                    │ swa-sc-nsportal│
                                                    │ (VITE_DEV_MODE)│
                                                    └───────────────┘
```

## Components

- **Ingestion (Azure Function, timer trigger).** Calls the NetSuite RESTlet with a `{ searchID }`, receives rows, coerces `{value,text}` list fields to plain text, stamps each row with `loaded_at`, and inserts into Azure SQL. Config-driven: the set of searches is an array of `{ searchID, tableName }`, so adding a source is a one-line change.
- **Storage (Azure SQL).** One table per saved search. Snapshot-append model — every load adds rows with a fresh `loaded_at`, so historical trend queries are possible later. Never truncate-and-replace.
- **Presentation (React + Vite, Azure Static Web App).** Reads the current snapshot and renders one chart, one KPI card, and one group-by/pivot table. Runs in `VITE_DEV_MODE=true` for the demo so there is no MSAL sign-in on screen.

## Why this shape

It mirrors the proven Nexus ops portal (`sc-ops-portal`) so the risky part — the NetSuite auth + RESTlet contract — is reused rather than reinvented. Everything here is deliberately minimal and legible; production hardening (auth, retries, monitoring, migrations) is intentionally out of scope for the prototype.
