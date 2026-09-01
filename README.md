# Office Pool Reborn

A private NFL/NCAA football paper-trading pool. Virtual shares are not money and cannot be redeemed, deposited, or withdrawn.

## Local setup

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:direction-contract
```

Copy `.dev.vars.example` to `.dev.vars` and provide local secrets when later tasks require them. Fixture-backed local flows do not need external odds credentials. To iterate against live odds without deploying, add `ODDS_API_KEY` directly to your ignored `.dev.vars` file (never commit or share it), then run `npm run dev`. It applies any pending local D1 migrations before starting the Vite preview, which uses `wrangler.local.jsonc`, local D1/DO state, and hot module replacement; local signups are automatically email-verified and mail is never delivered externally. Local development may set `ALLOW_INSECURE_LOCAL_AUTH=true` to bypass Turnstile for signup, signin, pool creation, and join; this is the only no-Turnstile mode and must never be configured in production.

### Production secrets

`BETTER_AUTH_SECRET` and `RESEND_API_KEY` are mandatory before the production Worker serves traffic. Auth email is sent through Resend from `Office Pool Reborn <noreply@officepool.football>`; the API key is a Worker secret, never a browser variable.

`POOL_COMMAND_AUTHENTICATOR_KEY` is mandatory in production. It authenticates password-bearing command fingerprints without storing a password verifier in command history; the Worker and PoolDO fail closed if it is absent. Set it as a Cloudflare secret to an independently generated value with at least 32 random bytes (for example, `openssl rand -base64 32`), never a password or committed configuration value. Rotate it only with a migration strategy that preserves verification of retained idempotency records.

`TURNSTILE_SECRET_KEY` is mandatory in production. Signup, signin, pool creation, and join fail closed when it is absent or verification fails. `ALLOW_INSECURE_LOCAL_AUTH=true` is strictly a local-development escape hatch, not a production setting.

`SETTLEMENT_SERVICE_TOKEN` authenticates the non-browser service boundary `POST /internal/pools/:poolId/settle`. Configure it as a Worker/DO secret and send it only as `x-settlement-service-token` from the settlement service; browser-originated, absent, or incorrect-token requests are denied.

## Cloudflare resources

`wrangler.jsonc` declares the production D1, a SQLite `PoolDO` migration, Queue, R2, scheduled cron bindings, and the `officepool.football` custom domain. Follow [the production deployment runbook](docs/production-deployment.md); it builds the public Turnstile site key into browser assets, keeps Worker secrets interactive, and validates the custom-domain deployment before publishing. See [architecture](docs/architecture.md), [operations and recovery](docs/operations.md), and the [accessibility review](docs/accessibility-review.md) for implementation and verification details.

### Service-only variables
`BACKUP_ENCRYPTION_KEY`, `POOL_PROJECTION_SERVICE_TOKEN`, and `POOL_BACKUP_SERVICE_TOKEN` are Worker/service-only variable names. They are not browser variables; production values belong in Worker secrets. The example values are local non-secret placeholders only.
