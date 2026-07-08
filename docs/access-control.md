# Access control

Who can read, write, and administer each piece. This is a prototype; IT will replace these with their standard roles when they rebuild.

## Repository (`sc-ns-data-portal`, public)

| Role | Who | Notes |
|---|---|---|
| Read | Everyone (public) | Code + markdown only — nothing sensitive is here |
| Write / commit | `JarrodServiceCompression` + invited collaborators | Changes deploy on push to `main` |
| Admin | `JarrodServiceCompression` | Settings, secrets, collaborators |

## Azure resources (RG `rg-sc-nsdata-portal`)

| Resource | Read | Write / Admin |
|---|---|---|
| SQL `sql-sc-nsportal` / db `scnsdata` | Function (via connection string in app settings) + portal readers | Jarrod / IT admins |
| Function `func-sc-nsportal` | — | Jarrod / IT admins |
| Static Web App `swa-sc-nsportal` | Public site (demo mode, no sign-in) | Jarrod / IT admins |
| Key Vault `kv-sc-nexus-scl` | Function's managed identity (get/list secrets only) | Existing Nexus admins |

## Secrets

NetSuite credentials are **read at runtime** by the Function's managed identity from Key Vault `kv-sc-nexus-scl`. No human copies them, no file stores them, and they are never in Git. The GitHub Actions deploy uses repo secrets (`AZURE_STATIC_WEB_APPS_API_TOKEN`) injected by Azure when the Static Web App is linked.

## Principle

Least privilege, and a hard separation: **the public repo has no path to secrets or data.** Compromising the repo yields code and docs — nothing else.
