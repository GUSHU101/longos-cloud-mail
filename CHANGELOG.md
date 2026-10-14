# Changelog

## v4.2.0 - 2026-10-14

### Security

- Replaced new single-pass SHA-256 password hashes with versioned PBKDF2-HMAC-SHA256 hashes, while transparently upgrading legacy hashes after a successful login.
- Replaced predictable random-password generation with rejection-sampled Web Crypto randomness.
- Hardened JWT parsing, signing-algorithm checks, payload validation, secret requirements, and malformed-token rejection.
- Replaced public batch-user SQL interpolation with fully bound D1 statements and added strict batch, domain, role, password, search, and pagination limits.
- Added mandatory signature verification for Resend webhooks using the raw payload and Svix headers; unsupported events no longer alter delivery status.
- Removed password hashes and salts from administrator user-list responses and stopped returning unexpected internal exception messages to clients.

### Reliability

- Fixed logout removing the wrong session token and accidentally persisting remaining sessions without expiration.
- Preserved raw inbound-message bytes across stream chunk boundaries and rejected deleted, banned, or unavailable recipients before storage.
- Made v3.0-v3.4 D1 migrations independently idempotent and fail closed on operational or SQL errors instead of silently accepting partial upgrades.
- Added bounded account/user queries, normalized configured mail domains, guarded missing records, and enforced account ownership on state-changing operations.
- Added GitHub Actions and manual deployment support for the `RESEND_WEBHOOK_SECRET` Worker Secret, with a complete signed-webhook setup procedure.

### Quality

- Expanded Worker regression coverage from 23 to 42 tests across passwords, JWTs, sessions, authorization boundaries, public API SQL binding, webhook verification, and migration failures.
- Removed leftover login-page debug logging.

## v4.1.1 - 2026-10-14

### Deployment and documentation

- Added a complete Chinese Cloudflare Workers deployment guide covering least-privilege API Tokens, D1, KV, R2, GitHub Actions, custom domains, Email Routing, first initialization, validation, backups, upgrades, rollbacks, and troubleshooting.
- Linked the Cloudflare and LONGOS deployment paths directly from both READMEs.
- Replaced the obsolete feature-branch upgrade instructions and the nonexistent `/api/health` check with the current `main` workflow and public configuration endpoint.
- Added an ignored local `wrangler-production.toml` path for safe manual deployments.

### Reliability

- Stopped hard-coding the D1 database name in generated production configuration.
- Added a distinct `D1_DATABASE_NAME` setting so explicit D1 IDs remain paired with their real resource names.
- Added fail-fast validation requiring the administrator address to belong to one of the configured mail domains.

## v4.1.0 - 2026-10-14

### Reliability

- Prevented administrator setting responses from mutating request-cached secrets and provider tokens.
- Added fail-fast recipient and attachment payload validation so malformed send requests return controlled business errors.
- Moved outbound attachment-count validation ahead of provider delivery to prevent delivered messages from being reported as failed and retried.
- Added one safe retry for transient self-hosted relay failures while preserving the same idempotency payload and rotating the HMAC nonce.
- Replaced the relay's blocking Postfix health probe with an asynchronous, cached, timeout-bounded check.
- Added relay concurrency and connection limits with retryable overload responses.

### Quality and supply chain

- Added end-to-end signed relay submission, idempotency, request-ID conflict, cached-setting isolation, attachment-limit, and retry tests.
- Consolidated VueUse onto v15 to remove three simultaneously bundled major versions.
- Pinned GitHub Actions to immutable commit SHAs and added production dependency audits, workflow concurrency, timeouts, and pre-deployment tests.
- Added weekly Dependabot coverage for GitHub Actions and all three JavaScript workspaces.

## v4.0.1 - 2026-10-14

### Security

- Replaced the URL-embedded database initialization secret with an authenticated `POST /api/init` request using a Bearer Worker Secret.
- Added fail-closed initialization authorization tests and no-store responses.
- Updated GitHub Actions runtimes to current Node 24-based releases.

## v4.0.0 - 2026-10-14

### Added

- Self-hosted Postfix/OpenDKIM mail engine with HMAC-signed HTTPS submission.
- LONGOS integrated relay support without requiring a separately managed relay checkout.
- Mail-engine selection for Auto, Cloudflare Email, Resend, and self-hosted delivery.
- Per-account sender identity propagation and provider/message ID audit fields.
- D1 migration for mail-engine settings and outbound provider metadata.
- Worker, frontend, and relay security tests in GitHub Actions.

### Security and reliability

- Isolated LONGOS and Cloud Mail relay client secrets.
- Replay protection, request idempotency, request/body/attachment/recipient limits, and per-sender/global rate limiting.
- Strict sender-domain and mailbox validation, credential-free relay URLs, and minimum secret length enforcement.
- JWT signing material and relay credentials are installed as Cloudflare Worker Secrets instead of plaintext variables.
- Request timeouts and payload-bound idempotency records for the relay HTTP server.
- Fail-closed database migrations: duplicate columns are skipped, unrelated D1 failures now stop deployment.
- Production deployment is manual and verified; Cloudflare Git Builds must remain disabled to prevent incomplete configurations from overwriting the Worker.
- Updated vulnerable AWS SDK, Cloudflare tooling, Axios, Vue, and related transitive dependencies.

### Upgrade notes

1. Back up the current D1 database and Worker settings.
2. Configure the GitHub Variables and Secrets documented in `doc/LONGOS_SELF_HOSTED_DEPLOYMENT.md`.
3. Disable Cloudflare Git Builds for this Worker.
4. Run `Deploy cloud-mail to Cloudflare Workers` from the `main` branch.
5. Confirm database initialization succeeds before selecting the self-hosted engine.
6. Do not configure `LONGOS_RELAY_URL` until its `/health` endpoint returns HTTP 200.

Upstream Cloud Mail license and attribution are retained. LONGOS-specific integration and modifications are released in this repository.
