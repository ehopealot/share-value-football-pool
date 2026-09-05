# Share Value Football Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a locally runnable Cloudflare React/Hono private football-pool application whose SQLite Durable Object authoritatively accounts for every pool share, wager, settlement, and member-visible history.

**Architecture:** The Worker authenticates, validates, routes, and owns D1 global registry/offers; one SQLite-backed PoolDO per pool serializes all authoritative membership, accounting, wagers, settlement, privacy, audit, and outbox changes. D1 projections and Queue delivery are repairable and never authorize, balance, or settle.

**Tech Stack:** Strict TypeScript, React Router/Vite Cloudflare plugin, Hono, Better Auth/Drizzle/D1, SQLite Durable Objects, Zod, noble scrypt, Queues, R2, Workers Vitest, fast-check, Playwright, axe, and plain CSS.

**Spec:** [`docs/superpowers/specs/2026-08-22-share-value-football-pool-design.md`](../specs/2026-08-22-share-value-football-pool-design.md)

## Global Constraints

- This is virtual paper trading only: no payments, deposits, withdrawals, prizes, or redeemable value.
- The approved compact 2007-era navy/blue/orange, table-oriented visual direction is fixed; do not copy trademarks, logos, claims, or obsolete behavior.
- Durable Object SQLite is authoritative; D1 projections and Queue wake-ups never authorize, balance, or determine settlement coverage.
- Accounting is canonical BigInt integer text only; JavaScript `number` and SQLite `REAL` are forbidden for share/value accounting.
- All browser mutations are authenticated, CSRF/origin protected, idempotent, and DO-authorized; pool passwords use independent-salt versioned scrypt with constant-time verification.

---

## Design notes
- **Foundation:** Strict TypeScript, React Router/Vite Cloudflare plugin, Hono, Better Auth Drizzle/D1, Zod, noble scrypt, Workers Vitest pool, fast-check, Playwright, axe, and plain CSS; `npm ci`/lockfile required. `wrangler.jsonc` uses only `src/db/migrations` for D1, declares PoolDO SQLite migration, D1/Queue/R2 bindings, and cron. Accounting is BigInt canonical integer text only (never `number`/`REAL`): share/value micros=1,000,000, round-half-even, whole-share risk, two/four/six-decimal display/detail formatting.
- **Literal root contract:** First `index.html` `<body>` child is this <=150-word HTML comment, retained in `dist` by seed grep: `THESIS: a private pool is operated from compact, auditable sports tables, never a generic dashboard. OWN-WORLD: navy and medium-blue bars, gray table fills, white fields, orange action controls, Arial/Verdana, square borders. STORY: members fund shares, confirm locked terms, and follow fair revealed results. FIRST VIEWPORT: centered mostly-fixed desktop canvas; navy masthead and blue navigation above a dense overview table with orange primary action; canvas becomes fluid on narrow screens. FORM: share-pool-operate-2007-v1. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md`.
- **Visual/accessibility:** Authored CSS variables implement period palette/status/focus/spacing/square borders; underlined links and native-shaped controls. No rounded/floating cards, shadows, glass, gradients, oversized marketing type, icon tiles, ornamental motion, copied trademarks/copy, or fabricated logo/testimonial/provider claims. Semantic landmarks/forms/tables, labels/error summaries, visible focus, non-color status symbols/text, reduced motion, and horizontally scrollable mobile odds tables are mandatory.
- **Authority/protocols:** Worker authenticates/validates/routes and reads D1 registry/offers only; PoolDO alone authorizes/mutates membership, season, accounts, wager/settlement/reveal/audit/outbox. D1 projections never authorize/balance/settle. Shared Zod contracts are `src/contracts/{http,commands,provider}.ts`; `Clock` is injectable. Create-pool reserves case-insensitive slug/D1 command response then calls idempotent DO initialization and projection intent; registry `initializing` repairs asynchronously. Matching retry returns original response/version; conflict is `IDEMPOTENCY_CONFLICT`.
- **Offer/results lifecycle:** Worker quotes D1 canonical offer snapshot/version/expiry; placement rereads offer and rejects stale/unavailable, returns `LINE_CHANGED` with replacement without lock, or `MARKET_LOCKED` at start/expiry, before DO stores immutable terms. Cron normalizes NFL/NCAAF offers, scores, status/correction versions; league discovery and events more than 24 hours before start poll every 20 minutes, scheduled events within 24 hours poll every 5 minutes, started nonfinal events poll every 2 minutes when quota permits, and final reconciliations run after 5 minutes and 24 hours, with quota backoff. D1 writes final/correction before settlement. Placement schedules that pool DO alarm; each DO queries D1 result/correction versions for its own referenced open events. Queue/projection wake-ups may optimize delivery but never determine settlement coverage or authorization. Outage leaves accepted wagers intact and exposes feed status. Super Bowl derives from NFL postseason metadata/name, commissioner confirms scheduled event, closes only final/all non-open (or float exhausted).
- **Wagers:** Canonical book order is DraftKings → FanDuel → BetMGM → Caesars. Ingestion selects the first book supplying the requested market; it never selection-shops. Sides/totals +100, moneyline accepted American odds; tied spreads/totals push, a tied two-way moneyline voids, cancellation/no-contest voids, and postponement holds only same ID/within 48h. Immutable `SHARE_POOL_2026_V1`: 2 legs 6/-120,6.5/-130,7/-140,7.5/-160; 3 +150/+135/+120/+105/10=-120; 4 +235/+215/+200/+140; 5 +350/+320/+300/+235; 6 +550/+500/+475/+325; 7 +800/+700/+600/+445. Regular teasers 2–7, 10pt exactly 3; no moneyline/duplicate/opposing market legs; a side plus total from one game is allowed. Adjust toward the member: favorite toward zero, underdog away from zero, over downward, under upward. Any loss loses; otherwise remove pushes/voids and reprice valid remainder or refund. Every accepted leg stores provider event ID, canonical book, retrieval time, policy/ruleset versions, original line/odds, and teaser adjusted line. Lock risk; win mints profit, loss burns, push/void returns; regrade atomically appends reversal and replacement in one DO transaction, retaining both source-result snapshots; zero float closes.
- **Security/identity:** Better Auth owns email/password, session rotation, verification/reset tokens; development mailbox is non-delivering. Pool password has separate independent-salt/versioned scrypt + constant-time check. Origin/CSRF/idempotency/DO authorization cover all mutations; Turnstile/rate limit cover signup/login/create/join. Secure HTTP-only SameSite-Lax production cookies; user text is text; logs omit secrets/picks. Suspended members retain immutable records but receive no pool read/mutation access until restore. Corrections/transfers need recent auth/reason.
- **Privacy/outbox/export:** Nonowner JSON omits team/event/market/selection/line/future-leg count before individual accepted start; commissioner has no exception. DO commits versioned outbox rows then alarm-drains pending rows to Queue post-commit, recording send attempts/delivery and bounded retry; consumer rejects old projection version and duplicates. Member exact-value export is authenticated GET from member-authorized DO data. Optional scheduled infrastructure backup uses configured R2 only: AES-GCM via Web Crypto, validated base64 key, fresh per-object nonce stored in object envelope, immutable ledger/audit JSON, no binding/key means disabled/health-not-configured. It is not a browser settlement endpoint.
- **Endpoint matrix:** `POST /api/pools` — `CreatePoolRequest/Response`, authenticated account/idempotent. `POST /api/p/:slug/join` — `JoinPool`, authenticated nonmember with rate-limit/Turnstile. `POST /api/p/:slug/admin/seasons` — `CreateSeason`, commissioner/idempotent. `POST /api/p/:slug/admin/seasons/:seasonId/open` — `OpenSeason`, commissioner/idempotent. `POST /api/p/:slug/admin/orders/quote` — `QuoteShareOrder`, commissioner/idempotent. `POST /api/p/:slug/admin/orders/execute` — `ExecuteShareOrder`, commissioner/idempotent. `POST /api/p/:slug/admin/orders/:orderId/reverse` — `ReverseShareOrder`, commissioner/idempotent. `POST /api/p/:slug/wagers/straight/quote` — `QuoteStraightWager`, active member/idempotent. `POST /api/p/:slug/wagers/straight/place` — `PlaceStraightWager`, active member/idempotent. `POST /api/p/:slug/wagers/teasers/quote` — `QuoteTeaser`, active member/idempotent. `POST /api/p/:slug/wagers/teasers/place` — `PlaceTeaser`, active member/idempotent. `POST /api/p/:slug/admin/settings` — `UpdatePoolSettings`, commissioner/idempotent. `POST /api/p/:slug/admin/transfer` — `TransferCommissioner`, commissioner/idempotent/recent-auth/reason. `POST /api/p/:slug/admin/members/:memberId/suspend` — `SuspendMember`, commissioner/idempotent. `POST /api/p/:slug/admin/members/:memberId/restore` — `RestoreMember`, commissioner/idempotent. `POST /api/p/:slug/admin/corrections/:wagerId/void` — `VoidWager`, commissioner/idempotent/recent-auth/reason. `POST /api/p/:slug/admin/corrections/:wagerId/regrade` — `RegradeWager`, commissioner/idempotent/recent-auth/reason. `POST /api/p/:slug/admin/history/:seasonId/annotations` — `CreateSeasonAnnotation`, commissioner/idempotent. `GET /api/p/:slug/view`, `GET /api/p/:slug/standings`, `GET /api/p/:slug/activity`, `GET /api/p/:slug/wagers`, `GET /api/p/:slug/history/:seasonId`, and `GET /api/p/:slug/export` are member-only. Every mutation returns its resulting command version and may return `IDEMPOTENCY_CONFLICT`, forbidden/suspended, stale/unavailable, `LINE_CHANGED`, `MARKET_LOCKED`, or retryable DO unavailable. `POST /internal/pools/:poolId/settle` uses a service binding and cannot be browser-routed. `GET /health/app`, `GET /health/d1`, `GET /health/do`, `GET /health/odds`, and `GET /health/queue` are non-sensitive.
- **Route/state matrix:** `/` shows signed-out explanation/login links or signed-in projected memberships; `/sign-up`, `/login`, `/forgot-password`, and `/reset-password` provide account actions; `/pools/new` creates; `/p/:slug` is overview/join gate; `/p/:slug/odds`, `/p/:slug/teaser`, `/p/:slug/my-wagers`, `/p/:slug/standings`, `/p/:slug/activity`, `/p/:slug/rules`, `/p/:slug/history/:seasonId`, `/p/:slug/admin/members`, `/p/:slug/admin/orders`, `/p/:slug/admin/season`, `/p/:slug/admin/corrections`, and `/p/:slug/admin/settings` are member/role routes. `/p/:slug/rules` always renders the fixed teaser table, canonical source policy, actual source/timestamp, and feed status. Named states are: no memberships→create/join; closed signup→ask commissioner; zero shares→wait for commissioner order; no active season→commissioner opens draft; no odds→return later; stale/provider error→view last poll and retry later; retryable DO error→retry with no speculative balance; closed season→read archive/export. Every state gives that permitted next action.

## TDD plan
1. `tests/domain/fixed-point.test.ts` — BigInt/text/Zod JSON, safe-integer boundaries, signed ties, odds, display formats.
2. `tests/domain/grading.test.ts` — every straight/teaser/postponement/push/void rule.
3. `tests/domain/ledger.property.test.ts` — fast-check seed/path/shrink model, order/settlement/reversal/cache/journal/ranking/zero-float invariants.
4. `tests/auth/better-auth.test.ts` and `tests/worker/registry.test.ts` — D1 auth verification/reset/session/mailbox and fake `PoolCommandClient` registry saga.
5. `tests/durable/pool-authority.test.ts` and `orders-ledger.test.ts` — actual Workers-pool SQLite authority/new-draft accounts/command retention/concurrent orders.
6. `tests/odds/ingestion.test.ts` — offers/scores/corrections/poll windows/reconciliation/D1-before-DO/outage/Super Bowl.
7. `tests/durable/wagers-settlement.test.ts` — concurrent wagers, snapshots, alarms/regrade/closure.
8. `tests/durable/privacy-outbox.test.ts` — shaping and committed-outbox drainer recovery.
9. `tests/worker/{security,queue-health,exports,api}.test.ts` — auth/abuse, projection consumer/health, AES-GCM export, post-redaction HTTP/internal-settlement denial.
10. `tests/local/local-smoke.test.ts` — terminating migrations/seed/fixture clock and production 404 test controls.
11. `e2e/{auth-and-join,orders-and-wagers,privacy-and-settlement,responsive-a11y}.spec.ts` — deterministic seeded flows, browser reset, WCAG/viewport states.

## Risks
- Pin Better Auth and Workers-pool compatibility; Better Auth adapter schema is authoritative for identities.
- Cross-store operations have repairable states, not transactions; exercise every retry path.
- Fixture controls compile/bind only in local/test; production tests must prove their absence.
- Confirm The Odds API retention/plan and Cloudflare limits before production configuration; local tests use no external credentials.

## TASKS
```json
[
  {
    "id": "T1",
    "title": "Bootstrap strict app, tests, and literal direction contract",
    "files": [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vite.config.ts",
      "wrangler.jsonc",
      "index.html",
      ".dev.vars.example",
      "vitest.config.ts",
      "playwright.config.ts",
      "src/index.ts",
      "src/web/main.tsx",
      "src/web/styles.css",
      "tests/setup.ts",
      "README.md",
      "scripts/capture-screenshots.ts"
    ],
    "summary": "Create reproducible Cloudflare tooling, bindings, dependencies, base CSS, and retained root contract.",
    "changes": "Pin all Design-notes packages, configure D1/DO/Queue/R2/cron and scripts `verify:direction-contract`, `test:local-smoke`, `screenshots`, build/test/e2e. Add the literal contract and CSS variables/base semantic/accessibility/period exclusions. Define `screenshots:initial` and `screenshots:final` invoking `scripts/capture-screenshots.ts` with seeded routes `odds`, confirmation, standings/activity, and error/closed at 1280x800 and 390x844, writing `artifacts/screenshots/{initial,final}-{route}-{desktop,mobile}.png`.",
    "acceptance": "npm ci && npm run typecheck && npm test && npm run build && npm run verify:direction-contract",
    "dependsOn": [],
    "tests": [
      "tests/setup.ts"
    ]
  },
  {
    "id": "T2",
    "title": "Implement fixed-point grading and teaser rules",
    "files": [
      "src/domain/fixed-point.ts",
      "src/domain/odds.ts",
      "src/domain/grading.ts",
      "src/domain/teaser-table.ts",
      "src/domain/types.ts",
      "tests/domain/fixed-point.test.ts",
      "tests/domain/grading.test.ts"
    ],
    "summary": "Create pure BigInt accounting and grading primitives.",
    "changes": "Write red tests before code for all fixed-point, formatting, straight, teaser-table, leg-validation, and result rules in Design notes.",
    "acceptance": "npm test -- tests/domain/fixed-point.test.ts tests/domain/grading.test.ts",
    "dependsOn": [
      "T1"
    ],
    "tests": [
      "tests/domain/fixed-point.test.ts",
      "tests/domain/grading.test.ts"
    ]
  },
  {
    "id": "T3",
    "title": "Implement property-tested ledger model",
    "files": [
      "src/domain/ledger.ts",
      "src/domain/season.ts",
      "tests/domain/ledger.property.test.ts"
    ],
    "summary": "Provide deterministic accounting/lifecycle transitions and invariant property tests.",
    "changes": "Use fast-check recorded seeds/paths/shrinking; test huge values, accounts, order rounding, locks, outcomes/regrades, ranking, and zero float.",
    "acceptance": "npm test -- tests/domain/ledger.property.test.ts",
    "dependsOn": [
      "T2"
    ],
    "tests": [
      "tests/domain/ledger.property.test.ts"
    ]
  },
  {
    "id": "T4",
    "title": "Add D1 identity, contracts, registry reservation, and auth boundary",
    "files": [
      "src/db/schema.ts",
      "src/db/migrations/0001_initial.sql",
      "src/contracts/http.ts",
      "src/contracts/commands.ts",
      "src/contracts/provider.ts",
      "src/platform/clock.ts",
      "src/auth/index.ts",
      "src/auth/email-sender.ts",
      "src/services/season-entitlement.ts",
      "src/services/pool-registry.ts",
      "src/services/pool-command-client.ts",
      "src/worker/bindings.ts",
      "tests/auth/better-auth.test.ts",
      "tests/worker/registry.test.ts"
    ],
    "summary": "Create D1 data/contracts and independently testable reservation/auth behavior.",
    "changes": "Use Better Auth adapter tables plus registry/projection/sports/delivery tables. Test signup/login/verification/reset/dev mailbox/session rotation. Test D1 reservation against fake PoolCommandClient only; record initializing/ready/failed repair/idempotency states. Real DO saga test belongs after T5.",
    "acceptance": "npm test -- tests/auth/better-auth.test.ts tests/worker/registry.test.ts && npx wrangler d1 migrations apply DB --local --config wrangler.jsonc",
    "dependsOn": [
      "T1"
    ],
    "tests": [
      "tests/auth/better-auth.test.ts",
      "tests/worker/registry.test.ts"
    ]
  },
  {
    "id": "T5",
    "title": "Build PoolDO authority and complete real create-pool saga",
    "files": [
      "src/durable/schema.ts",
      "src/durable/pool-do.ts",
      "src/durable/pool-commands.ts",
      "src/security/pool-password.ts",
      "src/services/pool-registry.ts",
      "tests/durable/pool-authority.test.ts",
      "tests/worker/create-pool-saga.integration.test.ts"
    ],
    "summary": "Implement authoritative pool/member/season commands and real D1-to-DO initialization.",
    "changes": "Parameterized SQLite pool/member/season/processed-command tables; one commissioner, join/password rotation, suspension denies all reads/mutations until restore, draft creates zero accounts for every persistent member, open/no-overlap/closed rules, command version/replay/conflict and retention cleanup. Complete real saga retry/repair against DO.",
    "acceptance": "npm test -- tests/durable/pool-authority.test.ts tests/worker/create-pool-saga.integration.test.ts",
    "dependsOn": [
      "T2",
      "T4"
    ],
    "tests": [
      "tests/durable/pool-authority.test.ts",
      "tests/worker/create-pool-saga.integration.test.ts"
    ]
  },
  {
    "id": "T6",
    "title": "Implement share orders and ledger persistence",
    "files": [
      "src/durable/accounting-commands.ts",
      "src/durable/accounting-repository.ts",
      "src/durable/schema.ts",
      "src/contracts/commands.ts",
      "tests/durable/orders-ledger.test.ts"
    ],
    "summary": "Add transactional commissioner orders and share accounts.",
    "changes": "Implement quote/execute/reverse, default form-only order, price/version tokens, canonical integer journal/cache invariants and concurrent order spending. Do not claim wager concurrency here.",
    "acceptance": "npm test -- tests/durable/orders-ledger.test.ts",
    "dependsOn": [
      "T3",
      "T5"
    ],
    "tests": [
      "tests/durable/orders-ledger.test.ts"
    ]
  },
  {
    "id": "T7",
    "title": "Implement odds ingestion and result-source/query contracts",
    "files": [
      "src/odds/types.ts",
      "src/odds/the-odds-api-provider.ts",
      "src/odds/canonicalize.ts",
      "src/odds/ingestion.ts",
      "src/worker/cron.ts",
      "src/worker/offer-quotes.ts",
      "src/odds/result-source.ts",
      "src/contracts/provider.ts",
      "tests/fixtures/odds/*.json",
      "tests/odds/ingestion.test.ts"
    ],
    "summary": "Write canonical offers and D1-first result versions on the required schedule, and expose the DO result-source query contract.",
    "changes": "Normalize NFL/NCAAF events/offers/scores/status/corrections; choose the first complete book per market in exact DraftKings → FanDuel → BetMGM → Caesars order and never selection-shop. Enforce polling/final/reconciliation rules, stale/outage feed status, snapshots, Super Bowl recognition, and D1-first version persistence. Define only the result-source/query contract that lets a PoolDO inspect D1 final/correction versions for its own referenced events; concrete durable alarm scheduling belongs to T13. Projections never gate settlement.",
    "acceptance": "npm test -- tests/odds/ingestion.test.ts",
    "dependsOn": [
      "T2",
      "T4"
    ],
    "tests": [
      "tests/odds/ingestion.test.ts"
    ]
  },
  {
    "id": "T8",
    "title": "Implement early authenticated pool HTTP routes and abuse middleware",
    "files": [
      "src/worker/app.ts",
      "src/worker/routes.ts",
      "src/worker/schemas.ts",
      "src/worker/do-router.ts",
      "src/worker/security.ts",
      "src/security/turnstile.ts",
      "src/security/rate-limit.ts",
      "tests/worker/security.test.ts"
    ],
    "summary": "Expose auth/create/join/settings routes only, with security boundaries.",
    "changes": "Implement individual Zod routes through pool settings/season authority, CSRF/session/idempotency, secure cookies, Turnstile/rate limits, recent auth/reasons, text/log/secret controls, and DO unavailable behavior. Wager/read/export routes are deferred to later tasks.",
    "acceptance": "npm test -- tests/worker/security.test.ts && npm run build",
    "dependsOn": [
      "T4",
      "T5",
      "T6"
    ],
    "tests": [
      "tests/worker/security.test.ts"
    ]
  },
  {
    "id": "T9",
    "title": "Build accessible vintage account and pool-entry UI",
    "files": [
      "src/web/app.tsx",
      "src/web/router.tsx",
      "src/web/api.ts",
      "src/web/components/Layout.tsx",
      "src/web/components/Status.tsx",
      "src/web/pages/HomePage.tsx",
      "src/web/pages/AuthPages.tsx",
      "src/web/pages/NewPoolPage.tsx",
      "src/web/pages/PoolGatePage.tsx",
      "src/web/pages/StatePage.tsx",
      "e2e/auth-and-join.spec.ts"
    ],
    "summary": "Build auth/create/join and action-oriented entry states.",
    "changes": "Implement the full route/state matrix in Design notes: signed-in/out home, all account routes, create/join/closed join, and named next-action states. Test verified mailbox, destination preservation, semantic errors/focus, and no speculative retry update.",
    "acceptance": "npm run test:e2e -- e2e/auth-and-join.spec.ts",
    "dependsOn": [
      "T8",
      "T18"
    ],
    "tests": [
      "e2e/auth-and-join.spec.ts"
    ]
  },
  {
    "id": "T10",
    "title": "Build order and wager confirmation UI",
    "files": [
      "src/web/router.tsx",
      "src/web/pages/OverviewPage.tsx",
      "src/web/pages/OddsPage.tsx",
      "src/web/pages/TeaserPage.tsx",
      "src/web/pages/MyWagersPage.tsx",
      "src/web/pages/AdminSeasonPage.tsx",
      "src/web/pages/AdminOrdersPage.tsx",
      "src/web/components/Confirmation.tsx",
      "src/web/components/OddsTable.tsx",
      "e2e/orders-and-wagers.spec.ts",
      "src/web/api.ts"
    ],
    "summary": "Build funded betting and confirmation surfaces.",
    "changes": "Implement filters, keyboard odds table, order forms, straight/teaser builders, confirmations, open/settled tickets, source/feed status and all quote errors/no-cancel behavior.",
    "acceptance": "npm run test:e2e -- e2e/orders-and-wagers.spec.ts",
    "dependsOn": [
      "T6",
      "T13",
      "T18",
      "T19",
      "T9"
    ],
    "tests": [
      "e2e/orders-and-wagers.spec.ts"
    ]
  },
  {
    "id": "T11",
    "title": "Build member views, archive, and commissioner administration",
    "files": [
      "src/web/router.tsx",
      "src/web/pages/StandingsPage.tsx",
      "src/web/pages/ActivityPage.tsx",
      "src/web/pages/RulesPage.tsx",
      "src/web/pages/HistoryPage.tsx",
      "src/web/pages/AdminMembersPage.tsx",
      "src/web/pages/AdminCorrectionsPage.tsx",
      "src/web/pages/AdminSettingsPage.tsx",
      "src/web/pages/AdminSeasonPage.tsx",
      "e2e/privacy-and-settlement.spec.ts",
      "src/web/api.ts"
    ],
    "summary": "Build redacted member views and constrained commissioner controls.",
    "changes": "Render formatted standings/activity/rules/archive and transfer/correction/annotation/Super Bowl administration; test reveal/regrade/archive/prohibitions and suspended denial/restoration.",
    "acceptance": "npm run test:e2e -- e2e/privacy-and-settlement.spec.ts",
    "dependsOn": [
      "T13",
      "T14",
      "T18",
      "T19",
      "T10"
    ],
    "tests": [
      "e2e/privacy-and-settlement.spec.ts"
    ]
  },
  {
    "id": "T12",
    "title": "Run bounded finish review and publish documentation",
    "files": [
      "README.md",
      "docs/operations.md",
      "docs/architecture.md",
      "docs/accessibility-review.md",
      "artifacts/screenshots/",
      "src/web/styles.css",
      "src/web/app.tsx",
      "artifacts/detector.json",
      "artifacts/detector.exit",
      "scripts/capture-screenshots.ts",
      "scripts/verify-design-md.mjs",
      "scripts/run-finish-review.mjs",
      "package.json",
      "src/web/router.tsx",
      "src/web/api.ts",
      "src/web/pages/OddsPage.tsx",
      "src/web/pages/TeaserPage.tsx",
      "src/web/pages/StandingsPage.tsx",
      "src/web/pages/ActivityPage.tsx",
      "src/web/pages/StatePage.tsx",
      "src/web/components/Confirmation.tsx",
      "src/web/components/OddsTable.tsx"
    ],
    "summary": "Run normal verification, one detector/screenshot review batch, and capture finish evidence.",
    "changes": "Implement `npm run finish:review` in `scripts/run-finish-review.mjs` as the executable finish runner: Phase A fail-fast runs typecheck, unit, e2e, build, direction-contract verification, deploy dry-run, then initial screenshots; Phase B invokes exactly once `node \"$HOME/.pi/agent/skills/impeccable/scripts/detect.mjs\" --json index.html src/web`, captures its stdout in `artifacts/detector.json` and its exit status in `artifacts/detector.exit`, and does not treat that detector status as ordinary verification; Phase C inspects detector/screenshots and applies one material fix batch only in listed screenshot surfaces; Phase D reruns the ordinary checks fail-fast against the rebuilt source/dist and takes final screenshots without rerunning the detector. The runner must use sequential process execution with explicit status handling, not shell semicolon chains. Record findings and fixes in `docs/accessibility-review.md` and operations/recovery/provider-limit docs.",
    "acceptance": "npm run finish:review (implemented by `scripts/run-finish-review.mjs`) fails fast for every ordinary Phase A/D check; runs exactly once `node \"$HOME/.pi/agent/skills/impeccable/scripts/detect.mjs\" --json index.html src/web`; records its stdout in `artifacts/detector.json` and exit status in `artifacts/detector.exit`; permits one listed-surface fix batch; rebuilds and re-verifies before the sole final recapture; and exits nonzero if any required ordinary verification fails.",
    "dependsOn": [
      "T11",
      "T16",
      "T17",
      "T19"
    ],
    "tests": [
      "e2e/responsive-a11y.spec.ts"
    ]
  },
  {
    "id": "T13",
    "title": "Implement PoolDO wagers, settlement alarms, and closure",
    "files": [
      "src/durable/wager-commands.ts",
      "src/durable/settlement.ts",
      "src/durable/alarm.ts",
      "src/odds/result-source.ts",
      "src/durable/schema.ts",
      "src/contracts/commands.ts",
      "tests/durable/wagers-settlement.test.ts"
    ],
    "summary": "Persist immutable tickets, schedule durable settlement alarms on placement, and settle from D1 result versions.",
    "changes": "Implement whole-risk concurrent placement and immutable accepted snapshots (provider event ID, canonical bookmaker, retrieval time, policy/ruleset versions, original line/odds, and teaser adjusted line). On durable wager placement, schedule the pool DO alarm; its alarm queries T7's D1 result-source contract for final/correction versions of its own referenced open events, with bounded retry. Implement result-version idempotency, atomic one-transaction regrade reversal and replacement retaining both source-result snapshots, float/Super Bowl closure, and a service-only settlement command with no browser route.",
    "acceptance": "npm test -- tests/durable/wagers-settlement.test.ts",
    "dependsOn": [
      "T2",
      "T5",
      "T6",
      "T7"
    ],
    "tests": [
      "tests/durable/wagers-settlement.test.ts"
    ]
  },
  {
    "id": "T14",
    "title": "Implement redacted reads, committed outbox, and Queue drainer",
    "files": [
      "src/durable/views.ts",
      "src/durable/outbox.ts",
      "src/durable/alarm.ts",
      "src/durable/pool-do.ts",
      "src/contracts/commands.ts",
      "tests/durable/privacy-outbox.test.ts"
    ],
    "summary": "Centralize privacy and post-commit outbox production.",
    "changes": "Shape all views recursively; DO alarm selects committed pending rows, sends versioned Queue messages after commit, records attempts/delivery, uses bounded retry and recovers Queue-send failure. Test reveal/no fields, commissioner parity, committed-not-enqueued recovery and duplicate/out-of-order semantics.",
    "acceptance": "npm test -- tests/durable/privacy-outbox.test.ts",
    "dependsOn": [
      "T5",
      "T13"
    ],
    "tests": [
      "tests/durable/privacy-outbox.test.ts"
    ]
  },
  {
    "id": "T15",
    "title": "Implement projection consumer and health endpoints",
    "files": [
      "src/services/projections.ts",
      "src/worker/queue.ts",
      "src/worker/health.ts",
      "src/worker/routes.ts",
      "src/worker/schemas.ts",
      "tests/worker/queue-health.test.ts"
    ],
    "summary": "Consume outbox events idempotently and expose operational health.",
    "changes": "Persist projection attempts, reject stale versions, repair delivery, keep direct DO access authoritative; add app/D1/DO/odds/queue health. Test duplicate Queue delivery and failure recovery.",
    "acceptance": "npm test -- tests/worker/queue-health.test.ts",
    "dependsOn": [
      "T8",
      "T14"
    ],
    "tests": [
      "tests/worker/queue-health.test.ts"
    ]
  },
  {
    "id": "T16",
    "title": "Add deterministic WCAG and responsive verification",
    "files": [
      "e2e/responsive-a11y.spec.ts",
      "e2e/fixtures/local-pool.ts",
      "tests/accessibility/contrast.test.ts"
    ],
    "summary": "Prove accessibility across main and state pages.",
    "changes": "Using seeded clock, run axe plus keyboard/focus/error/table/outcome, contrast, 200% reflow, 390px retained-header/overflow/touch/reduced-motion assertions on every named primary route and every named state in the Design-notes route/state matrix.",
    "acceptance": "npm run test:e2e -- e2e/responsive-a11y.spec.ts && npm test -- tests/accessibility/contrast.test.ts",
    "dependsOn": [
      "T9",
      "T10",
      "T11",
      "T18",
      "T19"
    ],
    "tests": [
      "e2e/responsive-a11y.spec.ts"
    ]
  },
  {
    "id": "T17",
    "title": "Implement authorized exact export and optional encrypted R2 backup",
    "files": [
      "src/services/audit-export.ts",
      "src/worker/backup-cron.ts",
      "src/worker/routes.ts",
      "src/worker/schemas.ts",
      "src/contracts/http.ts",
      "tests/worker/exports.test.ts",
      "src/worker/health.ts",
      "src/index.ts",
      "wrangler.jsonc"
    ],
    "summary": "Separate member export from configured infrastructure backup.",
    "changes": "Add only authenticated member `GET /api/p/:slug/export`; no commissioner/admin backup UI. Infrastructure cron in `src/index.ts` invokes backup handler when R2/key configured. Use AES-GCM envelope/unique nonce/base64 key validation; health says disabled without binding/key; no secrets/browser output.",
    "acceptance": "npm test -- tests/worker/exports.test.ts",
    "dependsOn": [
      "T8",
      "T14",
      "T15"
    ],
    "tests": [
      "tests/worker/exports.test.ts"
    ]
  },
  {
    "id": "T18",
    "title": "Implement deterministic local seeds and bounded local smoke harness",
    "files": [
      "scripts/seed-local.ts",
      "src/odds/fixtures/runtime.ts",
      "src/worker/test-controls.ts",
      "tests/local/local-smoke.test.ts",
      "package.json",
      "src/worker/routes.ts"
    ],
    "summary": "Make all local journeys repeatable without external services.",
    "changes": "Seed completed API data and test-only controls; terminating smoke starts local emulation, migrates, seeds, exercises create/join/order/wager/read, and always stops. Production has no test controls (404).",
    "acceptance": "npm test -- tests/local/local-smoke.test.ts && npm run test:local-smoke",
    "dependsOn": [
      "T8",
      "T15",
      "T17",
      "T19"
    ],
    "tests": [
      "tests/local/local-smoke.test.ts"
    ]
  },
  {
    "id": "T19",
    "title": "Implement later wager/read HTTP API and privacy integration",
    "files": [
      "src/worker/routes.ts",
      "src/worker/schemas.ts",
      "src/worker/do-router.ts",
      "src/contracts/http.ts",
      "tests/worker/api.test.ts"
    ],
    "summary": "Expose post-settlement wager, read, history, and export API surfaces.",
    "changes": "Add exact individual routes/contracts from matrix; Worker offer recheck then DO commands; recursively test external JSON redaction, member/suspended roles, command version/errors, and deny browser `SettleEventVersion`.",
    "acceptance": "npm test -- tests/worker/api.test.ts",
    "dependsOn": [
      "T8",
      "T13",
      "T14",
      "T15",
      "T17"
    ],
    "tests": [
      "tests/worker/api.test.ts"
    ]
  },
  {
    "id": "T20",
    "title": "Verify visual finish artifacts and post-fix DESIGN.md",
    "files": [
      "artifacts/screenshots/",
      "artifacts/detector.json",
      "artifacts/detector.exit",
      "DESIGN.md",
      "docs/accessibility-review.md",
      "dist/",
      "scripts/verify-design-md.mjs",
      "scripts/verify-finish-artifacts.mjs",
      "package.json",
      "docs/finish-verdict.md",
      "src/web/styles.css",
      "src/web/app.tsx"
    ],
    "summary": "Review the sole recapture and record the finish verdict without another detector run.",
    "changes": "Use final source, final dist, and final rendered screenshots in scan mode to generate DESIGN.md with canonical frontmatter/section order and actual CSS tokens. Implement `npm run verify:finish-artifacts` in `scripts/verify-finish-artifacts.mjs` as a fail-fast artifact validator, not a shell chain. Write docs/finish-verdict.md disposing each detector finding and every screenshot criterion (density, overflow, focus, exclusions); do not invoke detector.",
    "acceptance": "npm run verify:finish-artifacts (implemented by `scripts/verify-finish-artifacts.mjs`) fail-fast validates canonical DESIGN.md structure/tokens, a nonempty verdict disposing every detector finding and screenshot criterion, and the recorded detector/final screenshot artifacts.",
    "dependsOn": [
      "T12"
    ],
    "tests": []
  }
]
```

## Needs approval