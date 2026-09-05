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

Copy `.dev.vars.example` to `.dev.vars` in the canonical Git-common checkout and provide local secrets when later tasks require them. `npm run dev` uses the fixture-backed local Worker entry, so local flows do not use an external odds credential. The first linked-worktree run safely preserves any worktree-local `.dev.vars` under the ignored canonical `.wrangler/dev-vars-backups/` directory and links the worktree to the canonical file. It applies pending local D1 migrations before starting the worktree's Vite/Worker preview with hot module replacement and ignored `.wrangler/state` beside Git's common checkout. That D1/Durable Object state and local configuration are shared only by shared-state-compatible main and linked worktrees: they must preserve storage schemas and local Wrangler identities (worker name, D1 binding/database identity, and Durable Object class/migration identity). Run only one `npm run dev` process at a time. This Linux-only shared launcher requires util-linux `flock`; direct Vite/IDE dev servers are rejected because they bypass the lock. Stop the server before deliberately resetting `.wrangler/state`, and do not start an older or identity-incompatible checkout against it—use separate state or reset it deliberately instead. Local signups are automatically email-verified and mail is never delivered externally. The checked-in local Worker entry enables the no-Turnstile development path, local identity header, and test controls only for requests whose hostname is `localhost` or `127.0.0.1`; the production entry never enables them.

### Production secrets

`BETTER_AUTH_SECRET` and `RESEND_API_KEY` are mandatory before the production Worker serves app or browser traffic. The independently token-gated settlement service route remains available without them. Auth email is sent through Resend from `Office Pool Reborn <noreply@officepool.football>`; the API key is a Worker secret, never a browser variable.

`POOL_COMMAND_AUTHENTICATOR_KEY` is mandatory in production. It authenticates password-bearing command fingerprints without storing a password verifier in command history; the Worker and PoolDO fail closed if it is absent. Set it as a Cloudflare secret to an independently generated value with at least 32 random bytes (for example, `openssl rand -base64 32`), never a password or committed configuration value. Rotate it only with a migration strategy that preserves verification of retained idempotency records.

`TURNSTILE_SECRET_KEY` is mandatory in production. Signup, signin, pool creation, and join fail closed when it is absent or verification fails. The no-Turnstile path exists only in the checked-in local Worker entry and additionally requires a `localhost` or `127.0.0.1` hostname; the production entry disables it.

`SETTLEMENT_SERVICE_TOKEN` authenticates the non-browser service boundary `POST /internal/pools/:poolId/settle`. Configure it as a Worker/DO secret and send it only as `x-settlement-service-token` from the settlement service; browser-originated, absent, or incorrect-token requests are denied.

## Cloudflare resources

`wrangler.jsonc` declares the production D1, a SQLite `PoolDO` migration, Queue, R2, scheduled cron bindings, and the `officepool.football` custom domain. Follow [the production deployment runbook](docs/production-deployment.md); it builds the public Turnstile site key into browser assets, keeps Worker secrets interactive, and validates the custom-domain deployment before publishing. See [architecture](docs/architecture.md), [operations and recovery](docs/operations.md), and the [accessibility review](docs/accessibility-review.md) for implementation and verification details.

### Service-only variables
`BACKUP_ENCRYPTION_KEY`, `POOL_PROJECTION_SERVICE_TOKEN`, and `POOL_BACKUP_SERVICE_TOKEN` are Worker/service-only variable names. They are not browser variables; production values belong in Worker secrets. The example values are local non-secret placeholders only.
