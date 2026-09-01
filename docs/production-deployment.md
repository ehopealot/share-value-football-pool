# Office Pool Reborn production deployment

This runbook deploys the production Worker at `https://officepool.football`. The Worker is the apex origin for every path. PoolDO remains authoritative; D1 and the Queue are projection/evidence infrastructure.

## Provisioned resources

`wrangler.jsonc` binds these production resources:

- Worker: `office-pool-reborn`
- D1: `office-pool-reborn`
- Durable Object: `POOL_DO`
- R2: `office-pool-reborn-backups`
- Queue: `office-pool-reborn-events`
- Custom Domain: `officepool.football`

The custom-domain binding requires an active Cloudflare zone and no conflicting apex CNAME. It creates the Worker origin, DNS record, and certificate for the apex.

## Prerequisites

1. Create/configure a managed Turnstile widget for `officepool.football` before building. Register `localhost` and `127.0.0.1` only for local development; production verification requires the `officepool.football` hostname and the `submit` action. Its **site key** is public; its secret is not.
2. Confirm the Resend sender `Office Pool Reborn <noreply@officepool.football>` is verified.
3. Use the repository-pinned Wrangler executable (`./node_modules/.bin/wrangler`) for normal deployment commands.
4. Do not put any production value in `.dev.vars`, `wrangler.jsonc`, or source control.

## Set Worker secrets interactively

Each command prompts for a value without putting it in shell history. Run every required command separately; never paste a secret into chat or a command argument.

```sh
./node_modules/.bin/wrangler secret put BETTER_AUTH_SECRET --config wrangler.jsonc
./node_modules/.bin/wrangler secret put RESEND_API_KEY --config wrangler.jsonc
./node_modules/.bin/wrangler secret put POOL_COMMAND_AUTHENTICATOR_KEY --config wrangler.jsonc
./node_modules/.bin/wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.jsonc
./node_modules/.bin/wrangler secret put SETTLEMENT_SERVICE_TOKEN --config wrangler.jsonc
./node_modules/.bin/wrangler secret put POOL_PROJECTION_SERVICE_TOKEN --config wrangler.jsonc
./node_modules/.bin/wrangler secret put POOL_BACKUP_SERVICE_TOKEN --config wrangler.jsonc
./node_modules/.bin/wrangler secret put BACKUP_ENCRYPTION_KEY --config wrangler.jsonc
```

Set `ODDS_API_KEY` the same way if production odds ingestion is enabled. `BETTER_AUTH_SECRET` and `RESEND_API_KEY` are required before the Worker serves any production request. All other listed values are service-only; do not prefix them with `VITE_`.

Confirm only the binding names afterward:

```sh
./node_modules/.bin/wrangler secret list --config wrangler.jsonc
```

## Build, migrate, and deploy

Build the browser bundle with the public Turnstile site key. The key is deliberately supplied only for this build; never substitute the Turnstile secret.

```sh
VITE_TURNSTILE_SITE_KEY='public-site-key-from-turnstile' npm run build:production
./node_modules/.bin/wrangler d1 migrations apply DB --remote --config wrangler.jsonc
./node_modules/.bin/wrangler deploy --dry-run --config wrangler.jsonc
npm run verify:production-artifact
./node_modules/.bin/wrangler deploy --keep-vars --config wrangler.jsonc
```

`npm run build:production` requires the public site key, excludes Worker-secret environment variables, and must happen before either deploy command because Wrangler uploads static assets from `dist/client`. The dry run validates the generated Worker and custom-domain configuration without publishing it. `--keep-vars` protects any non-secret dashboard variable that is intentionally not declared in the repository; Worker secrets are never deleted by deploy.

## Post-deploy checks

1. Verify `https://officepool.football/health/app` returns HTTP 200.
2. Create a disposable account, complete the Resend verification email, sign in, request a password reset, and confirm the reset link succeeds.
3. Confirm protected signup/signin, pool creation, and join requests reject an absent or replayed Turnstile response.
4. Review Workers Logs for errors only. Invocation logs are intentionally disabled because Better Auth links carry single-use tokens in their query strings.

If a deployment must be reverted, inspect the deployed version and use Wrangler rollback rather than changing resource bindings by hand:

```sh
./node_modules/.bin/wrangler versions list --config wrangler.jsonc
./node_modules/.bin/wrangler rollback --config wrangler.jsonc
```
