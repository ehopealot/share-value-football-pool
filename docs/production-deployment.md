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

## GitHub Actions repository setup

Configure these repository-level GitHub Actions values:

- Secret `CLOUDFLARE_API_TOKEN`: a token scoped to the production Cloudflare account and `officepool.football` zone with only **Account > Workers Scripts: Edit**, **Account > D1: Edit**, and **Zone > Workers Routes: Edit** permissions. These are the least privileges required to deploy this configured Worker and apply its remote D1 migrations; do not use a Global API Key.
- Secret `CLOUDFLARE_ACCOUNT_ID`: the production Cloudflare account ID. Wrangler CI authentication requires it alongside `CLOUDFLARE_API_TOKEN`; do not add it to source configuration.
- Variable `VITE_TURNSTILE_SITE_KEY`: the public production Turnstile site key used by the production build.

Do not copy any Worker runtime secret into GitHub. Existing Worker runtime secrets remain in Cloudflare and are managed with `wrangler secret put` as documented below.

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

Deploy through the guarded production command. Never run `vite build` or `wrangler deploy` directly for production.

Create the ignored local public-build file once (it must contain no Worker secrets):

```sh
cat > .env.production.local <<'EOF'
VITE_TURNSTILE_SITE_KEY=public-site-key-from-turnstile
EOF
```

Then use the routine deployment command:

```sh
./node_modules/.bin/wrangler d1 migrations apply DB --remote --config wrangler.jsonc
npm run deploy:production
```

`npm run deploy:production` reads only `VITE_TURNSTILE_SITE_KEY` from `.env.production.local`; an explicitly exported shell value takes precedence. It requires a valid Turnstile site-key format, performs the isolated production build, creates a local dry-run artifact, verifies that no public placeholder remains, and only then publishes the verified generated Worker configuration with `wrangler deploy --keep-vars`. It excludes Worker-secret environment variables from the build and removes Cloudflare credentials before Wrangler runs for local OAuth deployments. In GitHub Actions, `CI=true` deliberately passes only the scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to Wrangler subprocesses. `--keep-vars` protects any non-secret dashboard variable intentionally not declared in the repository; Worker secrets are never deleted by deploy.

## Post-deploy checks

1. Verify `https://officepool.football/health/app` returns HTTP 200.
2. Create a disposable account, complete the Resend verification email, sign in, request a password reset, and confirm the reset link succeeds.
3. Confirm protected signup/signin, pool creation, and join requests reject an absent or replayed Turnstile response.
4. Review persisted Workers Logs and traces for errors and latency. Runtime logs, invocation URLs, and automatic trace URLs may include Better Auth's single-use query tokens; access must remain limited to production operators.
5. This deployment deliberately enables 100% log and trace sampling, invocation logs, persisted source maps, and the Worker Logpush event source for maximum native diagnostics. Persisting this data is an explicitly accepted debugging tradeoff. `logpush: true` enables delivery to a separately configured Workers Logpush job; it does not create that destination.

If a deployment must be reverted, inspect the deployed version and use Wrangler rollback rather than changing resource bindings by hand:

```sh
./node_modules/.bin/wrangler versions list --config wrangler.jsonc
./node_modules/.bin/wrangler rollback --config wrangler.jsonc
```
