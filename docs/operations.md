# Operations and recovery

## Local operation

Run `npm run dev` for the Vite/Worker local environment. It applies local D1 migrations first. The local fixture controls are development-only and are absent from production. Do not inspect, print, or commit `.dev.vars`.

Useful local checks:

```sh
npm run typecheck
npm test
npm run test:structure
npm run test:e2e
npm run build:production
npm run verify:direction-contract
```

Use `npm run build:local` only for a local Wrangler dry-run build. It does not publish a Worker.

## Health and recovery

`/health/app` confirms Worker application availability. The Worker also exposes D1, Durable Object, odds, and Queue health paths for operator diagnostics. A failed odds poll blocks only new quotes when the relevant offers are stale; accepted tickets remain immutable and settle once provider results are available.

A started event is intentionally excluded from the current odds board. If local manual fixtures have expired, reseed them or use the local controls to finalize the intended fixture; do not modify production provider data to repair a local test state.

Durable Object alarms retry settlement. Repeated service delivery is safe because commands and result versions are idempotent. Use the authorized audit export to inspect immutable accounting evidence before any commissioner correction. Correct an order only with a reversing order and correct a graded wager only with the constrained void/regrade flow.

## Provider limits

The odds adapter records poll observations and respects configured freshness windows. Provider errors, quota backoff, and no-offer states are visible to members as concise feed status. Do not expose provider API keys, raw provider credentials, or hidden wager selections in logs, screenshots, or support material.

## Production publishing

Publishing is an explicit operator action. A dry-run (`wrangler deploy --dry-run`) is not a deployment. Before a real publish, follow [the production deployment runbook](production-deployment.md), verify the production artifact, confirm migrations remotely, and use Cloudflare OAuth or an authorized secret path. Never substitute a copied browser key or a local environment file for production secret configuration.
