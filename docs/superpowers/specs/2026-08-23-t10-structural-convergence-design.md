# T10 Structural Convergence Design

**Status:** Approved direction; design amendment pending operator review
**Date:** 2026-08-23
**Parent design:** `2026-08-22-share-value-football-pool-design.md`
**Scope:** Bounded T10 structural convergence for order/wager confirmation UI, season-scoped `ReadPoolView`, Worker/DO production-vs-local composition, and E2E lifecycle seams. It changes no product capability or deployment behavior.

## 1. Purpose

Repeated T10 fix/review rounds exposed four implementation-boundary failures: mutable editor state reaches confirmation; one overloaded season field represents draft, active, and closed seasons; local fixture code remains in the production graph; and the browser harness fragments process ownership, backpressures pipes, and races cleanup.

This amendment replaces page-level patches with a bounded refactor of those four seams. It does not change PoolDO authority, accounting, privacy, wager rules, commissioner permissions, visual direction, deployment scope, or the parent-design automatic season-close rule.

## 2. Preserved Decisions and Exclusions

The refactor preserves:

- PoolDO as the sole authorization and accounting authority; D1 remains a disposable projection and canonical public-offer store.
- Stable, distinct quote, placement, and reversal idempotency keys; explicit `LINE_CHANGED` and `ORDER_QUOTE_STALE` reconfirmation; current non-reversed settlement projection and immutable correction history.
- Owner-only immutable wager terms and whole-leg pre-kickoff redaction for every nonowner, including commissioners; BigInt fixed-point accounting and round-half-even formatting.
- Positive whole-share wager risk, focused actionable errors, teaser source odds, date/league/market filters, and the approved compact navy/blue/orange interface.
- Real local Worker, Better Auth, D1, Durable Object, Queue, and browser flows: no route mocks, fabricated authorization, fabricated command result, or fabricated projection row.
- Explicit loopback-only fixture access, deterministic odds fixtures, and no production deployment or resource creation.

No T11, T12, T16, T20, Resend adapter/configuration, deployment, public manual close-season API/permission, or unrelated cleanup belongs in this refactor.

## 3. Architecture

### 3.1 Immutable confirmation snapshots

Straight wager, teaser, and commissioner share-order pages use the same lifecycle vocabulary without one universal component:

```text
editing -> quoting -> reviewing -> submitting
                         |              |
                         +-- requote <--+  (replacement terms require explicit review)
```

Each page may use its own reducer, but its state is a discriminated union. `ReviewPanel`/confirmation rendering accepts only the `reviewing` snapshot prop; it receives no editor object, callback, or mutable-form selector. A focused component seam test proves a review render cannot read editor state.

- `editing` owns controls and one quote key for its current semantic input; wager editing also owns the browser-minted `wagerId` for that semantic request.
- Starting a quote atomically copies semantic input into an immutable request snapshot and enters `quoting`. Semantic controls are disabled and the handler is single-flight.
- Quote validation failure returns to `editing`, retains the request/editor values, quote key, and wager ID, and presents the actionable error. Quote transport failure returns to `editing` with the same snapshot/keys available for retry; it does not invent a quote result.
- A parsed successful response enters `reviewing` with the request snapshot and complete authoritative quote snapshot. Confirmation and submission use only those values.
- Submission uses a distinct stable mutation key. A lost placement response and retryable DO failure retain the reviewing snapshot, wager ID, quote key, and mutation key; retry sends exactly that key and snapshot and must return the original stored response. A terminal non-stale placement rejection, including `MARKET_LOCKED` or `SEASON_NOT_ACTIVE`, retains reviewed terms only for explanation, retires the rejected mutation and quote keys, disables confirmation, and returns to `editing` before another quote.
- `LINE_CHANGED` or `ORDER_QUOTE_STALE` contains no authoritative replacement quote key or snapshot. It retains `wagerId` only for the error explanation, retires the old mutation and quote keys, disables confirmation, and returns to `editing`. The browser mints a fresh quote key, explicitly re-quotes the unchanged or edited semantic terms, and may enter `reviewing` only after that new authoritative quote succeeds; it never merges stale price/version fields onto browser quantities.
- A semantic edit after review returns to `editing` and mints a new quote key and wager ID.

Shared contracts define and Zod-parse these response shapes at the Worker/UI boundary. `decimalString = z.string().regex(/^(?:0|-?[1-9]\d*)$/)`; `positiveDecimalString` additionally excludes zero, `americanOdds = z.number().int().refine((odds) => odds !== 0)`, and all timestamps are `z.string().datetime()`. UI-only formatted currency, profit, total-return, and line-display strings are derived after parsing and are never placement-command fields.

```ts
const CanonicalOfferProof = z.object({
  offerId: z.string().min(1), eventId: z.string().min(1),
  offerVersion: z.string().min(1), canonicalBook: z.string().min(1),
  market: z.enum(["spread", "total", "moneyline"]),
  selection: z.enum(["home", "away", "over", "under"]),
  odds: americanOdds, line: z.number().finite().nullable(),
});
const CommonLeg = z.object({
  eventId: z.string().min(1), league: z.enum(["nfl", "ncaaf"]),
  canonicalBook: z.string().min(1), retrievedAt: timestamp,
  policyVersion: z.string().min(1), offerVersion: z.string().min(1),
  canonicalOfferProof: CanonicalOfferProof,
  market: z.enum(["spread", "total", "moneyline"]),
  selection: z.enum(["home", "away", "over", "under"]),
  originalLine: z.number().finite().nullable(), adjustedLine: z.number().finite().nullable(),
  originalOdds: americanOdds, eventStartsAt: timestamp,
  homeTeam: z.string().min(1), awayTeam: z.string().min(1),
});
const addProofMirroringIssues = (leg: z.infer<typeof CommonLeg>, ctx: z.RefinementCtx) => {
  const proof = leg.canonicalOfferProof;
  if (proof.eventId !== leg.eventId || proof.offerVersion !== leg.offerVersion ||
      proof.canonicalBook !== leg.canonicalBook || proof.market !== leg.market ||
      proof.selection !== leg.selection || proof.odds !== leg.originalOdds ||
      proof.line !== leg.originalLine) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proof must mirror leg" });
};
const StraightLeg = CommonLeg.superRefine((leg, ctx) => {
  addProofMirroringIssues(leg, ctx);
  const validSelection = leg.market === "total" ? ["over", "under"].includes(leg.selection) : ["home", "away"].includes(leg.selection);
  if (!validSelection || (leg.market === "moneyline" && (leg.originalLine !== null || leg.adjustedLine !== null)) ||
      (leg.market !== "moneyline" && (leg.originalLine === null || leg.adjustedLine !== leg.originalLine)))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid straight leg terms" });
});
const TeaserPoints = z.union([z.literal(6), z.literal(6.5), z.literal(7), z.literal(7.5), z.literal(10)]);
type TeaserPoints = z.infer<typeof TeaserPoints>;
const TeaserLeg = (teaserPoints: TeaserPoints) => CommonLeg.extend({
  market: z.enum(["spread", "total"]), originalLine: z.number().finite(), adjustedLine: z.number().finite(),
}).superRefine((leg, ctx) => {
  addProofMirroringIssues(leg, ctx);
  const validSelection = leg.market === "spread" ? ["home", "away"].includes(leg.selection) : ["over", "under"].includes(leg.selection);
  // Spread lines are selected-side lines: +points moves both favorites toward zero and underdogs away from zero.
  const expectedAdjustedLine = leg.market === "spread" ? leg.originalLine + teaserPoints : leg.selection === "over" ? leg.originalLine - teaserPoints : leg.originalLine + teaserPoints;
  if (!validSelection || leg.adjustedLine !== expectedAdjustedLine)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid teaser leg terms" });
});
const StraightWagerQuoteSnapshot = z.object({
  quoteKey: z.string().min(1), seasonId: z.string().min(1), ownerMemberId: z.string().min(1),
  riskMicros: positiveDecimalString, acceptedOdds: americanOdds,
  rulesetVersion: z.string().min(1), leg: StraightLeg,
  commandVersion: decimalString,
});
const TeaserWagerQuoteSnapshot = z.object({
  quoteKey: z.string().min(1), seasonId: z.string().min(1), ownerMemberId: z.string().min(1),
  riskMicros: positiveDecimalString, acceptedOdds: americanOdds,
  teaserPoints: TeaserPoints, rulesetVersion: z.string().min(1), legs: z.array(CommonLeg).min(2).max(7),
  commandVersion: decimalString,
}).superRefine((quote, ctx) => {
  quote.legs.forEach((leg, index) => {
    const result = TeaserLeg(quote.teaserPoints).safeParse(leg);
    if (!result.success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["legs", index], message: "invalid teaser leg" });
  });
  if (quote.teaserPoints === 10 && quote.legs.length !== 3)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["legs"], message: "10-point teasers require exactly three legs" });
});
const ShareOrderQuoteSnapshot = z.object({
  seasonId: z.string().min(1), memberId: z.string().min(1),
  mode: z.enum(["shares", "value"]), amountMicros: positiveDecimalString,
  sharesMicros: decimalString, valueMicros: decimalString, priceMicros: decimalString,
  commandVersion: decimalString,
});
```

`acceptedOdds` is the accepted American-odds integer ticket-price term for both straight wagers and teasers; `acceptedTicketPriceMicros` does not exist. Every accepted leg carries the canonical source (`canonicalBook`, `retrievedAt`), `policyVersion`, `offerVersion`, and `canonicalOfferProof`. Before dispatching placement, Worker revalidation checks the canonical offer and its version/proof against the current D1 canonical offer; only then may it send the parsed projection to PoolDO. `possibleProfitMicros` and `totalReturnMicros` may be derived for display from `riskMicros` and `acceptedOdds`, but are neither quote authority nor placement fields.

The browser mints `wagerId` when it creates a semantic wager quote request and retains it through review and placement replay. `quoteKey` is the stable browser-minted quote command key; `mutationKey` is a distinct stable placement command key. Both are browser-owned UUID/string identifiers and are not interchangeable with `wagerId`.

Quote requests are constructible before any quote result exists; they do not embed a placement ticket, `acceptedOdds`, a quoted command version, or a server-issued replacement key. Their separate schemas are:

```ts
const StraightQuoteRequestLeg = z.object({
  eventId: z.string().min(1), canonicalBook: z.string().min(1),
  market: z.enum(["spread", "total", "moneyline"]),
  selection: z.enum(["home", "away", "over", "under"]),
  offerId: z.string().min(1), offerVersion: z.string().min(1),
});
const TeaserQuoteRequestLeg = StraightQuoteRequestLeg.extend({
  market: z.enum(["spread", "total"]),
});
const QuoteStraightWager = z.object({
  type: z.literal("QuoteStraightWager"), commandId: z.string().min(1), // quoteKey
  actorId: z.string().min(1), wagerId: z.string().min(1), seasonId: z.string().min(1),
  riskMicros: positiveDecimalString, rulesetVersion: z.string().min(1),
  leg: StraightQuoteRequestLeg, browserRequestFingerprint: z.string().min(1),
});
const QuoteTeaserWager = z.object({
  type: z.literal("QuoteTeaserWager"), commandId: z.string().min(1), // quoteKey
  actorId: z.string().min(1), wagerId: z.string().min(1), seasonId: z.string().min(1),
  riskMicros: positiveDecimalString, teaserPoints: TeaserPoints, rulesetVersion: z.string().min(1),
  legs: z.array(TeaserQuoteRequestLeg).min(2).max(7), browserRequestFingerprint: z.string().min(1),
});
```

On a successful authoritative quote, PoolDO durably stores an authoritative quote record keyed by `(actorId, quoteKey)`, with `wagerId`, the complete canonical placement terms (every field of the corresponding `Place*` projection except `type`, `commandId`, and the redundant actor identity), and the authoritative PoolDO `commandVersion`. The parsed successful response is that complete `StraightWagerQuoteSnapshot` or `TeaserWagerQuoteSnapshot`, including its browser-supplied `quoteKey` and stored `commandVersion`; the review contract is `{ wagerId, quoteKey, snapshot }` and requires `quoteKey === snapshot.quoteKey`. The stored record, not the browser snapshot, is authoritative.

The exact authoritative placement projections are `PlaceStraightWager = { type, commandId: mutationKey, actorId, wagerId, quoteKey, quotedCommandVersion, seasonId, riskMicros, acceptedOdds, rulesetVersion, leg }` and `PlaceTeaserWager = { type, commandId: mutationKey, actorId, wagerId, quoteKey, quotedCommandVersion, seasonId, riskMicros, acceptedOdds, teaserPoints, rulesetVersion, legs }`. `quotedCommandVersion` is copied unchanged from the reviewed snapshot; `leg` uses `StraightLeg`, and each teaser leg is validated by `TeaserLeg(teaserPoints)`. These projections exclude display-derived profit/return, but include all declared authoritative leg/source/team-label terms; PoolDO never accepts an editor object or browser-calculated payout. The Worker/PoolDO schemas use the same fields, with a moneyline placement `originalLine` represented as `null` (and normalized at the command boundary if storage uses an omitted optional); teaser `originalLine` and `adjustedLine` remain required finite numbers.

Placement is replay-first. The Worker first performs a processed-command lookup for `(actorId, mutationKey)` and, on an exact prior placement command, returns the stored result before D1 offer-freshness validation. Only for a non-replayed placement does the Worker revalidate every canonical offer/version/proof against current D1 canonical offers before dispatching to PoolDO. PoolDO likewise first returns its stored processed-command result for an exact replay. For a new command, in the same PoolDO transaction and before locking shares or inserting a wager, it requires that `(actorId, quoteKey)` identify a stored quote record with the submitted `wagerId`, that every authoritative placement term exactly equal that stored record, and that submitted `quotedCommandVersion`, stored quote `commandVersion`, and the current authoritative PoolDO `commandVersion` all be equal. A missing, altered, or superseded binding makes no balance, lock, wager, or ledger mutation and returns `LINE_CHANGED` for changed wager-line terms or `ORDER_QUOTE_STALE` for a version-only stale binding. Neither Worker D1 revalidation nor a browser-held snapshot substitutes for this transactional PoolDO comparison.

For a lost placement response or retryable failure, retain the reviewed snapshot, `wagerId`, `quoteKey`, `quotedCommandVersion`, and `mutationKey`; retry sends exactly that projection and key and receives the stored result even if D1 freshness would now fail. For `LINE_CHANGED` or `ORDER_QUOTE_STALE`, retain `wagerId` only for explanation, retire the old `mutationKey` and reviewed `quoteKey`, and return to editing. A browser-minted fresh quote key is required for the explicit re-quote; only its newly persisted authoritative snapshot may be reviewed and submitted with a newly minted mutation key. For `MARKET_LOCKED`, `SEASON_NOT_ACTIVE`, or any other terminal non-stale placement rejection, retain terms only for the error explanation, retire both rejected keys, then return to editing; the next semantic quote mints a new quote key and wager ID. A retryable quote failure retains its quote key and wager ID; a semantic edit retires them and mints replacements.

`QuoteShareOrder` requires `memberId`, `mode`, and `amountMicros`; normal and stale responses use the same complete shape. `ExecuteShareOrder` receives the reviewed snapshot, but PoolDO recomputes or validates shares/value from authoritative mode, amount, price, and version in its transaction; it never trusts browser-calculated derived values.

### 3.2 Explicit season lifecycle read model

`ReadPoolView` is a single shared Zod success schema, not overloaded `season` prose or an implicit second response:

```ts
const SeasonSummary = z.object({
  id: z.string().min(1), label: z.string().min(1), state: z.enum(["draft", "active"]),
  createdAt: timestamp, openedAt: timestamp.nullable(), closedAt: z.null(),
  defaultOrderMode: z.enum(["shares", "value"]).nullable(),
  defaultOrderAmountMicros: decimalString.nullable(), floatMicros: decimalString,
  notionalValueMicros: decimalString,
});
const ClosedSeasonSummary = SeasonSummary.extend({
  state: z.literal("closed"), closedAt: timestamp, closeReason: z.string().nullable(),
});
const SeasonBalance = z.object({
  seasonId: z.string().min(1), availableMicros: decimalString, lockedMicros: decimalString,
});
const ShareOrderSummary = z.object({
  orderId: z.string().min(1), memberId: z.string().min(1),
  mode: z.enum(["shares", "value"]), requestedMicros: decimalString,
  sharesMicros: decimalString, valueMicros: decimalString, priceMicros: decimalString,
  reversalOf: z.string().min(1).nullable(), reason: z.string(), createdAt: timestamp,
});
const SeasonOrders = z.object({ seasonId: z.string().min(1), orders: z.array(ShareOrderSummary) });
const MemberDirectoryEntry = z.object({
  memberId: z.string().min(1), displayName: z.string().min(1),
  role: z.enum(["commissioner", "member"]), status: z.enum(["active", "suspended"]),
});
const ReadPoolView = z.object({
  commandVersion: decimalString,
  pool: z.object({
    poolId: z.string().min(1), slug: z.string().min(1), name: z.string().min(1),
    commissionerId: z.string().min(1), signupsOpen: z.boolean(),
  }),
  activeSeason: SeasonSummary.nullable(), nextDraftSeason: SeasonSummary.nullable(),
  latestClosedSeason: ClosedSeasonSummary.nullable(),
  currentMember: z.object({
    memberId: z.string().min(1), role: z.enum(["commissioner", "member"]),
    seasonBalances: z.array(SeasonBalance),
  }),
  members: z.array(MemberDirectoryEntry),
  commissioner: z.object({ seasonOrders: z.array(SeasonOrders) }).nullable(),
});
```

This successful schema is member-only: an unauthorized/nonmember request receives the gate denial, not a partially populated `ReadPoolView`. Every authorized member receives pool metadata, its own `currentMember.role`, and the complete member directory needed to select and label share-order recipients. Directory `role` and `status` are visible only to authorized members; no order row is redacted inside the commissioner projection because `commissioner` is `null` for noncommissioners and is the only location where full `ShareOrderSummary` collections appear. `OverviewPage`, `AdminOrdersPage`, all season notices/navigation, standings/activity/history links, and every Worker/API reader parse this exact schema; no consumer may depend on legacy top-level `season`, `orders`, or untyped response fields.

All IDs, timestamps, enum values, and micros are explicit JSON strings (or the stated `null`); there are no unscoped balances or orders. In no-season state `seasonBalances` and commissioner `seasonOrders` are empty. In draft-only state each contains exactly the `nextDraftSeason.id` set (zero available/locked holdings and no orders until an order exists). Active-with-history contains sets for `activeSeason.id` and `latestClosedSeason.id` when authorized. Newly opened state assigns new live balance/order sets to `activeSeason.id` while `latestClosedSeason` remains independently linked and readable. The schema, rather than omitted ambiguous fields, documents all role redaction.

There is at most one active and one draft season. `latestClosedSeason` is selected by `closed_at DESC, id ASC`. A commissioner may create the next draft only when active and draft are both absent, even when closed history exists. Draft controls expose create/configure/open actions; active controls expose funded-order actions only. Closure remains automatic only on the parent-design conditions (Super Bowl completion with all wagers settled, or zero float). Closed history is read-only and never blocks the next draft.

`OverviewPage`, `AdminOrdersPage`, all season notices/navigation, standings/activity/history links, and every Worker/API reader of `ReadPoolView` migrate together. No-active, draft, active, and latest-closed notices render independently without contradiction. Contract and browser coverage exercise no season, draft only, active plus closed history, and a newly opened next season; they prove history remains addressable after next-draft creation and opening. Existing PoolDO overlap rejection remains authoritative.

The executable public recovery journey is:

```text
loopback-only close-season fixture (arrange a legitimately closed state only)
  -> public create next draft -> public configure/open -> public quote/execute order
```

The fixture is not a public route and grants no commissioner close action.

### 3.3 Separate production and local-test composition

`src/index.ts` is the production entry and imports production app construction, the configured `PoolDO` export, and a buildable fail-closed production `EmailSender`. T10 does not implement Resend. “No mailbox handlers” means no local mailbox inspection/control routes in the production graph; it does not prohibit the production sender interface. `src/index.local.ts` is the local/E2E entry and imports production behavior plus local route installation, local identity/session seams, deterministic alarm/projection controls, and the local sender/inspection behavior.

The local wrapper delegates normal commands to production PoolDO and may intercept only explicit loopback fixture operations. If retained, it exports the configured class as `PoolDO`, preserving the declared Durable Object binding/class/migration identity and persistence compatibility. Production contains no local route installers, impersonation headers, mailbox inspection handlers, fixture mutation code, `LOCAL_TEST_CONTROLS` branches, or `/__local-test` routing.

A checked-in config-parity script compares production and local configs for D1 binding and migration directory; DO binding, class, and migrations; Queue producer/consumer; R2; compatibility date/flags; assets; and cron. Only entry selection, loopback local routes, and local variables may differ. Production artifact tests scan generated JavaScript/routing for the checked-in forbidden local-control token/module list and prove `GET`, `POST`, and `OPTIONS /__local-test/*` are absent/404 under the production composition. The local projection barrier remains local-only and exercises committed outbox data, projection token, PoolDO snapshot reads, D1 persistence, and idempotent consumption.

### 3.4 Deterministic faults and one E2E lifecycle owner

A one-shot, local-only outbound transport barrier is permitted for quote/placement replay. It invokes the unmodified authenticated Worker/PoolDO handler, then delays or drops only its outbound response. It never fabricates payloads, authorization, command results, or projections. Browser tests separately prove disabled semantic controls during a live delayed quote; reducer/component tests inject a stale editor action to prove immutable review state. Replay asserts identical key/snapshot and the original stored result.

The harness has a worker-scoped build prerequisite and test-scoped isolated persistence plus Worker/process-group ownership. Each test receives unique fixture identities or a complete proven reset. A checkout-scoped ownership lock (used by the one serial acceptance runner) prevents concurrent Playwright invocations against the checkout/resource budget.

The owner performs: isolated persistence creation; D1 migration; local Wrangler CLI resolution (never `npx`); process-group launch; immediate stdout/stderr drainage to two 64 KiB ring buffers with explicit truncation markers; health readiness; browser execution; bounded TERM then KILL cleanup; and persistence removal in an outer `finally`. It uses direct process-group existence checks, not spawned `ps`, during normal cleanup. Cleanup preserves the primary failure and attaches bounded diagnostics/cleanup errors. Only resources bearing the checkout ownership tag are probed or removed.

Harness tests cover build, migration, launch, readiness, browser failure, cleanup, cleanup plus primary failure, and persistence-removal failure, including injected probe failures that fail closed.

## 4. Data and Error Flow

```text
editor input -> immutable request snapshot + stable quote key
  -> authenticated Worker -> PoolDO authorization/current state
  -> parsed complete authoritative quote snapshot -> immutable review UI
  -> distinct stable mutation key -> authoritative transaction
```

A changed line/version returns a stale rejection, then the browser explicitly submits a fresh browser-key quote request; lost response replay reaches real stored idempotency state before D1 freshness validation. D1 projections do not decide lifecycle or permission.

## 5. Testing and Final Serial Gate

Strict TDD applies: each production change begins with a failing focused contract.

- Shared-contract, reducer/component, Worker, and DO tests parse constructible unquoted straight and teaser quote requests plus complete authoritative snapshots, enforce transition/key retention, prove review isolation, replay unchanged snapshots, reject semantic key reuse, and validate/recompute share order values. Contract cases accept valid favorite, underdog, over, and under teaser adjustments and reject unadjusted or wrong-direction teaser lines plus invalid straight line/null combinations. DO tests prove altered placement terms and an intervening PoolDO version are rejected with no balance, lock, ledger, or wager mutation; browser/Worker/DO coverage proves a fresh browser-key re-quote and reconfirmation persists and places durably; and a lost placement response replay returns its stored result before D1 offer freshness validation.
- Read-model tests cover all four lifecycle combinations, exact closed-history tie ordering, season-scoped data, and all migrated consumers.
- Browser tests cover disabled delayed controls, stale-editor reducer action, delayed real command completion, dropped-response quote/placement replay, stale price in both order modes, automatic/fixture-arranged closure followed by public recovery, large-value formatting, and production route absence.
- Composition tests verify parity, both entry builds/starts, production artifact tokens, and production route probe.

The checked-in serial runner acquires the ownership lock and runs these exact commands/configurations from a clean checkout:

```text
npm run test:e2e -- --workers=1 e2e/orders-and-wagers.spec.ts
npm run test:e2e -- --workers=1 e2e/auth-and-join.spec.ts e2e/orders-and-wagers.spec.ts
npm test -- --maxWorkers=1
npm run test:local-smoke
npm run typecheck
npm run build
npm run build:local
npm run start:production-probe
npm run verify:direction-contract
npm run verify:wrangler-parity
npm run verify:production-artifact
npm run verify:production-route-probe
npm run verify:owned-resource-cleanup
```

`build:local`, `start:production-probe`, and each `verify:*` command above are required checked-in scripts/configurations before this gate is considered executable. The production route probe uses `GET`, `POST`, and `OPTIONS` and accepts only absent/404 local-test routing. The artifact verifier owns the explicit forbidden token/module list. The runner then performs diff and staged-file checks and confirms no tagged Worker, workerd, Playwright, or persistence resources remain. Fresh T10 reviewer and review-planner must return `CONVERGED` with no release-blocking finding.

## 6. Execution Boundaries

Implement serially, one writer at a time:

1. production/local composition, parity checks, deterministic fault barrier, and E2E ownership;
2. typed season lifecycle read model and public next-season recovery;
3. immutable confirmation snapshots and complete quote DTOs;
4. missing real-browser regressions and the executable final serial gate.

Each slice preserves passing behavior and receives focused review before the next. No commit is created until the approved final delivery point.

## 7. Risks and Controls

- **Over-generalized confirmation framework:** scope reducers/types to the three T10 flows; share vocabulary/helpers only.
- **DTO migration breadth:** define one shared contract and migrate every reader in its slice.
- **Config or DO identity drift:** enforce enumerated parity and retain `PoolDO` class identity.
- **Fault controls masking product bugs:** delay/drop only a real completed outbound response; assertions cross real command/read boundaries.
- **Harness cleanup harming unrelated work:** remove only ownership-tagged resources and retain primary failure diagnostics.

## 8. Acceptance

This design is complete when the four structural boundaries exist; every §2 preserved decision remains true; the serial gate passes; and fresh T10 reviewer plus review-planner return `CONVERGED` with no release-blocking findings.
