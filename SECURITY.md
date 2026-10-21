# Security Policy

## Production credential boundary

LONGOS Cloud Mail supports only a least-privilege Cloudflare API Token. Global API Keys are rejected. For one-time deployment, `node scripts/deploy-wizard.mjs` keeps credentials only in the current process and passes them to the deployer through its child environment; it does not write a configuration file, GitHub secret, command-line argument, or log. For GitHub Actions deployment, store production credentials in the protected GitHub `production` Environment, never in repository variables, workflow inputs, files, issues, screenshots, or logs. `node scripts/trigger-github-deployment.mjs` sends secret values to `gh secret set` through standard input and dispatches only non-secret JSON fields, but those Environment secrets remain stored until an administrator rotates or deletes them.

Forks and pull requests run only `.github/workflows/validate.yml`, which has read-only repository permission and receives no production secrets. Production deployment is manual, default-branch-only, repository-owner-only, re-run-owner-only, and protected by the `production` Environment. Dependency installation, audit, tests, and builds finish before the deployment step receives secrets.

The Cloudflare API Token stays inside the protected deployment runner. LONGOS exposes only an authenticated public DNS manifest; it never receives, stores, or logs the Cloudflare credential.

## Reporting a vulnerability

Do not open a public issue containing credentials, tenant data, email contents, exploit details, or infrastructure addresses. Use GitHub Private Vulnerability Reporting when enabled, or contact the repository owner privately. Include the affected version, impact, reproduction steps, and whether credentials may have been exposed.

## Credential exposure response

If a credential may have leaked:

1. Revoke the Cloudflare API Token immediately and create a new token limited to the required account and zones.
2. Revoke the LONGOS integration token in the control-site administration panel and create a replacement.
3. Replace both secrets in the GitHub `production` Environment and remove any duplicate repository-level secrets.
4. Re-run the production deployment from the protected default branch.
5. Rotate `JWT_SECRET` only when it may have leaked; doing so signs every Cloud Mail user out.
6. Review GitHub Actions runs, Cloudflare audit logs, LONGOS integration-token usage, and mail relay logs.

Never commit a replacement credential while attempting to remove an exposed one. Repository history and forks may retain old commits, so revocation is mandatory.
