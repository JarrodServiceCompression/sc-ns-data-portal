# Decisions — running log (append every step, with the WHY)

Newest at the bottom.

### D1 — Public repo, code + markdown only
**Why:** everyone in the room opens one link and watches the Actions tab; safe because the repo never holds secrets or data. Secrets live in Azure Key Vault, data in Azure SQL.

### D2 — Fresh Azure SQL, not Nexus's DB
**Why:** isolate the demo so nothing can touch the production Nexus database. New resource group `rg-sc-nsdata-portal` makes teardown trivial.

### D3 — Reuse the Nexus NetSuite integration (don't reinvent)
**Why:** the OAuth 1.0a TBA + RESTlet `script=1433` pattern is already proven in production. Lift the pattern; do not edit Nexus live.

### D4 — Config-driven ingestion
**Why:** start with the asset saved search but structure the pull as an array of `{ searchID, tableName }`, so adding or swapping a source is a one-line change, not a rewrite.

### D5 — Snapshot-append, never replace
**Why:** stamping every row with `loaded_at` preserves history, which is what makes week-over-week and trend tooling possible later.

### D6 — Viz app runs in VITE_DEV_MODE=true
**Why:** zero auth friction on screen during the demo — no MSAL sign-in. Auth is re-enabled when IT productionizes.

### D7 — Secrets via Key Vault reference, never typed into files or Git
**Why:** the Function references `kv-sc-nexus-scl` so the secret values never pass through the repo, the editor, or the operator. `.gitignore` excludes all env/secret files as a backstop.
