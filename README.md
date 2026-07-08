# sc-ns-data-portal

**Start here → read [`STATE.md`](./STATE.md), then browse [`/docs`](./docs).**

A small, end-to-end fleet data tool for **Service Compression**: a **NetSuite** saved search feeds **Azure SQL**, a minimal **React + Vite** app charts it, and a timer-triggered **Azure Function** refreshes it daily. Built live in Cowork as a prototype — IT will rebuild it to their standards, so it is kept documented and versioned.

## What this is (and isn't)

- **Is:** a legible reference implementation of the pull → store → visualize → schedule loop, reusing the proven NetSuite integration pattern from the Nexus ops portal.
- **Isn't:** production-hardened. No secrets and no fleet data ever live in this repo — **code and markdown only.**

## The shape of it

```
NetSuite saved search  ──(RESTlet, OAuth 1.0a TBA)──▶  Azure Function  ──▶  Azure SQL
                                                                              │
                                                        React + Vite viz app ◀┘
```

## Where to look

| You want to… | Open |
|---|---|
| Know where the build stands right now | [`STATE.md`](./STATE.md) |
| Understand the data flow | [`docs/architecture.md`](./docs/architecture.md) |
| See what was decided and why | [`docs/decisions.md`](./docs/decisions.md) |
| Know who can read/write/admin | [`docs/access-control.md`](./docs/access-control.md) |
| Run it, redeploy, or change the schedule | [`docs/runbook.md`](./docs/runbook.md) |
| See which saved searches feed it | [`docs/netsuite-config.md`](./docs/netsuite-config.md) |

## Secrets rule (say it out loud)

NetSuite credentials live in **Azure Key Vault** (`kv-sc-nexus-scl`), referenced by the Function — never in Git. Fleet **data** lives in **Azure SQL** — never in Git. `.gitignore` excludes every env/secret file. This repo is public precisely because it holds neither.
