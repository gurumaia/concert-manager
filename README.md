# Show Manager

MCP-first concert tracker. See docs as they land.

## Environments

| Env | Stack | Site | Deploys |
|---|---|---|---|
| dev | `show-manager-dev` | https://dev.concertmanager.enkel.cloud | `deploy-dev` workflow: auto on push to `main`, or dispatch on any branch |
| prd | `show-manager-prd` | https://concertmanager.enkel.cloud | `promote` workflow: manual dispatch, `main` only |

Per-environment values live in `env/<env>.params`. Local deploy: `./deploy.sh -e dev|prd -p <aws-profile>`.

One-time setup (admin credentials): deploy `infrastructure/github-oidc.yaml` (header has the command), then set the repo secrets
`AWS_DEPLOY_ROLE_DEV` / `AWS_DEPLOY_ROLE_PRD` from its outputs, and optionally `GOOGLE_CLIENT_ID_<ENV>`, `GOOGLE_CLIENT_SECRET_<ENV>`, `SETLISTFM_API_KEY_<ENV>`.
Each environment's Google OAuth client needs its own redirect URIs (see the stack outputs `GoogleCalendarRedirectUri` and `GoogleSignInRedirectUri`).

`backend/scripts/migrate-data.mjs` copies one environment's table into another and re-encrypts the stored Google tokens under the target's KMS key (dry run by default).
