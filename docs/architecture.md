# Architecture

## Authoritative boundaries

Office Pool Reborn uses a Cloudflare Worker as the HTTP boundary, D1 for global identity and provider data, and one SQLite Durable Object per pool for authoritative membership, share accounting, wagers, and administration. Browser reads and commands enter through Worker routes; the Pool Durable Object repeats authorization and serializes state-changing commands.

D1 projections are discoverability aids only. They never authorize a wager, calculate a balance, or settle a ticket. A delayed projection cannot weaken the Durable Object boundary.

## Browser application

The React application is served as Worker assets. `src/web/api.ts` owns typed browser transport and concise server-error presentation. Route pages request authoritative pool views and render compact, semantic tables. `Layout` derives its ribbon from the server session and leaves authentication controls absent while the session is unresolved, avoiding a logged-out flash during navigation.

## Odds and settlement

Odds ingestion writes normalized events and offers to D1. The current board includes only scheduled events that have not started. Wager quotes are rechecked against D1 immediately before Durable Object placement. Terminal events are refreshed in D1 at five minutes, two hours, and 24 hours after first finalization. Pool alarms settle immutable ticket snapshots on the first terminal observation, then reconcile retained results at 15 minutes, two hours, and 24 hours before completing the event lifecycle; browser routes cannot invoke settlement.

## Share accounting

Shares and virtual value use integer micros and BigInt arithmetic. The ledger is append-only; cached account and season values are transactionally maintained projections. Share orders and wager settlement are reversible only by explicit audited follow-up commands.

## Integrations

Better Auth owns account credentials and sessions. Resend is behind an email-sender boundary; no browser code handles secrets. Cloudflare Queues deliver post-commit projection work. Turnstile protects public mutation paths in production; local-only controls are not registered in production.
