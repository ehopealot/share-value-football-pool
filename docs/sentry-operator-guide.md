# Sentry error reporting

Sentry reporting is optional. With no configured DSN, Worker and browser reporting are disabled and application behavior is unchanged.

## Setup

Set the optional Worker `SENTRY_DSN` with the existing interactive Worker-secret process. Set the optional public `VITE_SENTRY_DSN` only in the guarded production-build/CI variable path; never put either value in source, `.dev.vars`, request URLs, or logs.

Source maps additionally require build-only `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT`. The auth token is not a Worker secret and is removed before Wrangler deploy. Without it, errors still report but are unsymbolicated. Worker release uses Cloudflare version metadata; browser symbolication uses Vite debug IDs.

Recommended alerts: new issue for unexpected command, post-commit alarm, or settlement-invariant failures; threshold alerts for provider/Queue failures; ticket-level alerts for coalesced backup failures. Do not alert on expected business responses, stale/no-offer, normal retries, or best-effort mail.

## Safe verification and rollback

Use the automated in-memory transport tests and generated-artifact checks. Do not create a public crash endpoint or deliberately crash production.

Removing `SENTRY_DSN` disables reporting for new Worker invocations after configuration propagation. Removing `VITE_SENTRY_DSN` requires a new browser build and deployment; already-open tabs can continue reporting until reload. Immediate browser ingestion shutdown requires the Sentry-side client-key/project control as well.

## Residuals

Sentry privacy controls do not alter existing Cloudflare Logs, tracing, Logpush, or Wrangler native source-map diagnostics. Those facilities retain the privacy/retention tradeoff documented in the production runbook and are separately operator-controlled.
