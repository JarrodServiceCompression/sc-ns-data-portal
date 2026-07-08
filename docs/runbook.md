# Runbook

Operational steps for the portal. Prototype-grade; commands are illustrative.

## Run the pull once (manually)

The pull is a timer-triggered Azure Function. To run it on demand:
1. Azure Portal → Function App `func-sc-nsportal` → **Functions** → the pull function → **Code + Test** → **Test/Run**.
2. Confirm the run logs show rows returned from NetSuite and inserted into Azure SQL.
3. Verify in SQL: `SELECT COUNT(*), MAX(loaded_at) FROM assets;`

## Change the schedule

The timer uses a CRON expression in the Function's `function.json` (or app setting `PullSchedule`). Example — daily at 06:00 UTC:
```
0 0 6 * * *
```
Edit, then redeploy the Function (see below). NCRONTAB is 6 fields (seconds first).

## Redeploy

- **Frontend (Static Web App):** push to `main`. GitHub Actions builds `app/` and deploys. ~1–2 min. Watch the **Actions** tab go yellow → green.
- **Function App:** deploy via the Function's configured method. ~3 min; **push once and let it finish** — back-to-back deploys can deadlock.

## Rotate / update NetSuite credentials

Credentials live in Key Vault `kv-sc-nexus-scl`. Update the secret there; the Function reads the new value at next run via its Key Vault reference. **Never** put credentials in the repo or app-setting plaintext.

## Verify data freshness

```sql
SELECT TOP 5 loaded_at, COUNT(*) AS rows
FROM assets
GROUP BY loaded_at
ORDER BY loaded_at DESC;
```
Each `loaded_at` is one snapshot. Rising row-groups over days = the daily pull is healthy.

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Pull returns 401 from NetSuite | Signature method / token drift | Confirm HMAC-SHA256; re-check TBA token in Key Vault |
| Rows have `{value, text}` blobs | List field not coerced | Coerce to `.text` (or `.value`) before insert |
| Chart empty | No snapshot yet, or wrong table | Run pull once; confirm `assets` has rows |
| Deploy stuck | Back-to-back Function pushes | Wait for the first to finish, redeploy once |
