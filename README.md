# Share Pool

A private NFL/NCAA football paper-trading pool. Virtual shares are not money and cannot be redeemed, deposited, or withdrawn.

## Local setup

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:direction-contract
```

Copy `.dev.vars.example` to `.dev.vars` and provide local secrets when later tasks require them. Fixture-backed local flows do not need external odds credentials. Local development may set `ALLOW_INSECURE_LOCAL_AUTH=true` to bypass Turnstile for signup, signin, pool creation, and join; this is the only no-Turnstile mode and must never be configured in production.

### Production secrets

`POOL_COMMAND_AUTHENTICATOR_KEY` is mandatory in production. It authenticates password-bearing command fingerprints without storing a password verifier in command history; the Worker and PoolDO fail closed if it is absent. Set it as a Cloudflare secret to an independently generated value with at least 32 random bytes (for example, `openssl rand -base64 32`), never a password or committed configuration value. Rotate it only with a migration strategy that preserves verification of retained idempotency records.

`TURNSTILE_SECRET_KEY` is mandatory in production. Signup, signin, pool creation, and join fail closed when it is absent or verification fails. `ALLOW_INSECURE_LOCAL_AUTH=true` is strictly a local-development escape hatch, not a production setting.

`SETTLEMENT_SERVICE_TOKEN` authenticates the non-browser service boundary `POST /internal/pools/:poolId/settle`. Configure it as a Worker/DO secret and send it only as `x-settlement-service-token` from the settlement service; browser-originated, absent, or incorrect-token requests are denied.

## Cloudflare resources

`wrangler.jsonc` declares local D1 migrations in `src/db/migrations`, a SQLite `PoolDO` migration, Queue, R2, and scheduled cron bindings. Production deployment is intentionally manual: configure the Cloudflare account and required secrets before any deploy command.

### Service-only variables
`BACKUP_ENCRYPTION_KEY`, `POOL_PROJECTION_SERVICE_TOKEN`, and `POOL_BACKUP_SERVICE_TOKEN` are Worker/service-only variable names. They are not browser variables; production values belong in Worker secrets. The example values are local non-secret placeholders only.
