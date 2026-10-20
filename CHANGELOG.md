# Changelog

## Unreleased

### Mail reliability and safety

- Made Cloud Mail relay retries idempotent by generating and reusing a stable request ID automatically, preventing duplicate delivery after an accepted response is lost.
- Added matching browser and Worker limits for recipients, attachment count and decoded attachment size, plus strict outbound header/body validation and reply ownership checks.
- Fixed Telegram email preview links with purpose-scoped, seven-day JWTs instead of trying to validate preview tokens as login sessions.

### Operations

- Added a public, non-sensitive `/api/health` readiness endpoint that verifies the required D1 state and KV binding, and made deployment validate it before and after retiring the initialization secret.
- Added best-effort `INIT_SECRET` retirement on every post-deployment failure path and stable 404 responses for missing attachment/static objects.

## v4.5.0 - 2026-10-20

### Simplified Cloudflare deployment

- Made GitHub Actions the primary no-terminal deployment path and added an optional Run Workflow form for the Worker name, custom domain, mail domains, administrator address, and LONGOS relay URL.
- Reduced the required stored configuration to two secrets and four ordinary variables for the recommended LONGOS path.
- Added safe single-account discovery, made `CLOUDFLARE_ACCOUNT_ID` optional, accepted simple/comma-separated mail domains, defaulted resource names, and automatically generated the first JWT signing secret while preserving it on upgrades.
- Fixed production rendering of JSON-valued domain and CORS variables so generated Wrangler TOML is syntactically valid, and aligned CI template validation with the real deployment renderer.
- Removed the standalone relay install/test cycle from Worker production deployment; the independent relay remains covered by its dedicated CI workflow.

### Self-hosted delivery by default

- Locked an installation with `LONGOS_INTEGRATION_TOKEN` to the LONGOS Postfix/OpenDKIM engine and rejected provider changes, preventing silent third-party delivery fallback.
- Simplified the mail-engine UI for integrated deployments and clearly marked the deployment-managed setting.
- Rewrote the main README and quick start around Cloudflare inbound routing, the Worker HTTPS gateway, LONGOS website integration, tenant-specific sending domains, and direct-to-MX delivery.

## v4.4.0 - 2026-10-19

### Deployment

- Added `node scripts/deploy-cloudflare.mjs`, a cross-platform guided production deployer that installs locked dependencies, runs tests/builds, creates or reuses D1/KV/R2, verifies the LONGOS token gateway, renders an ignored Wrangler production configuration, deploys secrets, initializes D1 with certificate-aware retries, and performs a final public endpoint check.
- Deploys code and required secrets together, removes disabled legacy/provider secrets, and revokes the single-use database initialization secret after verifying that it can no longer authorize requests.
- Added a single-page Chinese quick start that clearly separates Cloudflare inbound routing, Cloud Mail browser delivery, and LONGOS transactional order/recovery delivery.
- GitHub Actions now creates a missing R2 bucket, fails early when the LONGOS gateway or private mail stack is unhealthy, and retries initialization while a new Custom Domain certificate propagates.

### Transactional mail reliability

- Replaced success-only idempotency receipts with an fsync-backed `pending` / `accepted` / `released` journal. A crash after local Postfix acceptance now fails closed instead of automatically duplicating an order or abandoned-cart recovery email.
- Added Postfix queue depth, OpenDKIM process, journal writability and capacity, bounded nonce storage, canonical base64, authenticated malformed-request throttling, and sender/global backpressure checks. A full live journal now fails closed instead of evicting duplicate-prevention records.
- Exposed queue depth and uncertain-delivery counts through the authenticated health chain and expanded transient gateway retries while preserving the original request ID.
- Added relay contract tests for LONGOS order notifications and discounted abandoned-order recovery messages.

### Security and application reliability

- Sanitized untrusted email previews and administrator-authored HTML notices, constrained Telegram preview content with CSP, and disabled shared caching of tokenized preview pages.
- Added strict background-image URL/type/size validation and made replacement transactional so a failed upload no longer destroys the active background.
- Added setting-field allowlists, bounded numeric options, public HTTPS endpoint validation, runtime domain validation, and controlled recovery from malformed stored provider configuration.
- Added a final D1 schema/index assertion so a partially applied migration cannot be reported as a successful deployment.
- Hardened relay startup validation, global request throttling, request header/type checks, and signing-domain consistency.

## v4.3.0 - 2026-10-15

### Security

- Replaced OAuth binding by public provider user ID with a short-lived, single-use KV authorization ticket and an atomic D1 identity reservation.
- Scoped OAuth identities by provider, added a unique composite index, enforced same-origin callback URLs and random browser `state`, and bounded provider requests with timeouts.
- Added per-IP-and-identity authentication failure throttling for user login and public API-token issuance.
- Bounded Turnstile verification requests and converted provider outages or malformed responses into controlled authentication failures.
- Restricted browser API CORS to same-origin or an explicit allowlist, added private API security headers, and separated the automatically rotated D1 initialization secret from the JWT signing secret.
- Blocked private, credentialed, non-HTTPS webhook destinations; masked stored OAuth, webhook, bot, S3, Turnstile, and provider credentials without overwriting unchanged values.
- Replaced public LONGOS relay HMAC credentials with expiring, revocable `cloud-mail:send` / `cloud-mail:health` integration tokens. LONGOS uses token hashes for authentication and APP_KEY encryption for secure, administrator-requested retrieval, pins token traffic to the deployment relay URL, and disables credential-bearing redirects.
- Added owner-scoped, rate-limited token reveal auditing, previous-key decryption with automatic re-encryption to the current APP_KEY, active-owner validation, duplicate-hash resilience, and authoritative relay audit context.
- Made the control-site token platform-scoped: one control-domain binding now serves every active tenant, tenant identity is derived from the stable `+site-code` sender suffix, caller-supplied tenant fields are ignored, and child-domain gateway calls are rejected.

### Mail reliability

- Persisted successful relay idempotency receipts in a dedicated Docker volume, retained them across container restarts, and exposed storage failure through relay health checks.
- Added attachment-count, concurrent-send, connection, request, recipient, rate, and client-secret isolation safeguards to the self-hosted relay.
- Prevented stale Resend events from downgrading terminal delivery states and restricted status callbacks to matching Resend outbound rows.
- Moved custom webhook delivery to the email event background context, bounded webhook retries and timeouts, and bounded scheduled cleanup work.
- Fixed the half-hour analytics cron mismatch while preserving hourly maintenance and UTC daily resets.
- Added an authenticated end-to-end relay health check to Cloud Mail settings, covering the Worker secret, LONGOS token gateway, and private Postfix/OpenDKIM relay.
- Kept tenant mail access stable across storefront custom-domain changes and failed closed for unknown or suspended tenant site codes.

### Deployment and quality

- Removed committed development resource identifiers and secrets, added a safe `.dev.vars.example`, and made `pnpm test` local-only instead of deploying a test Worker.
- Made GitHub deployment install and audit both locked workspaces, run Worker tests and the production Vue build, generate an independent init secret, and initialize D1 without exposing the JWT signing key.
- Expanded Worker regression coverage from 42 to 59 tests across OAuth, CORS, response headers, outbound URL validation, integration-token pinning, secret masking, authentication throttling, relay health, and Turnstile failure handling, plus relay persistence coverage.

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
