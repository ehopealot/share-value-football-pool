# Parlays and Six-Leg Wager Cap Design

**Status:** Revised after architecture review; approved for implementation

## Goal

Add pre-game parlays to Office Pool Reborn and cap new parlays and teasers at six legs, without changing immutable accepted ticket terms, exact idempotent replay behavior, share accounting, privacy, or correction guarantees.

## Product rules

### Parlays

- A parlay has **2–6 legs** and may include NFL/NCAA spreads, totals, and moneylines.
- Spread and total legs use the pool's normal `+100` price. A moneyline uses its server-canonical, vig-free accepted price.
- An event may contain one directional market (**one spread or one moneyline**) and optionally one total. Thus spread-plus-total and moneyline-plus-total are allowed; spread-plus-moneyline is not. Exact duplicates and opposing selections in one market are rejected.
- A total paired with its event's directional leg is priced at `-133`; all other legs retain their normal price. Therefore `+100 × -133` locks at `+250`, rather than independent `+300`.
- Parlays use the immutable `PARLAY_2026_V1` ruleset. It is stored on every quote and wager, and quote, placement, settlement, correction, confirmation, and Rules UI dispatch from that identifier.
- The per-side exposure limit splits a parlay's original risk evenly across its original leg count, exactly as existing multi-leg teaser exposure does. It aggregates with straight and teaser exposure; total ticket risk remains capped separately.

### Exact pricing and settlement

Pricing uses reduced `BigInt` fractions—never floating-point arithmetic. An American price `+a` has multiplier `(a + 100) / 100`; `-a` has multiplier `(a + 100) / a`. The pricing module multiplies and reduces all leg multipliers. For positive total-return fraction `N/D`:

- when `N >= 2D`, lock `+floor(100 × (N - D) / D)`;
- when `D < N < 2D`, lock `-ceil(100 × D / (N - D))`;
- exact even money is canonical `+100`.

Every input and output American price must be a safe nonzero JavaScript integer. Before acceptance, the server exhaustively prices every nonempty push/void surviving-leg subset (at most 63 subsets for six legs), recomputing same-game adjustments each time; if the initial price or any reachable effective settlement price is unsafe, the quote fails with `PARLAY_ODDS_OUT_OF_RANGE` before durable mutation. This guarantees an accepted ticket remains settleable while preserving valid one-leg repricing. This is more conservative than the exact return and preserves the requested `+250` example.

A final losing leg settles the parlay immediately, as superseded by [`2026-09-03-early-multileg-loss-settlement-design.md`](2026-09-03-early-multileg-loss-settlement-design.md). Wins and refunds still wait until all legs are final. Pushes and voids are then removed; surviving legs are repriced with their immutable snapshots and the same versioned rules. If no legs survive, risk is refunded. If a pushed/voided leg breaks a same-game pair, the surviving total reverts to its ordinary `+100` price. Settlement persists nullable `settledOdds` for the effective win price, so owner/audit/history views never display the original quote as the price actually paid after repricing.

### Teaser cap and legacy compatibility

- New teaser quotes and fresh placements permit **2–6 legs**; ten-point teasers remain exactly three legs.
- The legacy seven-leg teaser table remains available for settlement, regrade, and historical views.
- Parsing stays compatible with a seven-leg legacy quote/placement envelope long enough to find an exact stored replay. Worker replay deliberately requires a successful D1 registry resolution from slug to PoolDO; after that resolution, the stored replay runs before PoolDO view work, mutable offer lookup, or placement revalidation. A registry outage remains a retryable pool-availability failure rather than introducing a second durable directory or naming migration. After replay misses, HTTP and PoolDO paths reject fresh seven-leg quote/placement attempts before any mutation. This preserves a previously successful seven-leg placement whose response was lost while preventing new seven-leg tickets.

## Architecture

A `parlay` wager type follows the teaser lifecycle:

1. The browser transfers a valid 2–6 leg tray all-or-nothing to a dedicated parlay builder.
2. The Worker canonicalizes all current offers and derives the only authoritative price.
3. The Pool Durable Object stores an immutable quote bound to owner, command version, ruleset, risk, complete legs, and accepted odds.
4. A member confirms placement; exact placement/quote replays are idempotent, while changed lines require fresh terms and explicit reconfirmation.
5. Settlement grades immutable legs and calls the same `PARLAY_2026_V1` function after push/void removal.

The pure pricing/selection module is shared by Worker canonicalization/revalidation, PoolDO placement validation, and settlement. Canonical leg validation is also centralized so proof/strike equality is required for non-moneylines only: moneyline proof retains the bookmaker price while `originalOdds` retains the server-calculated vig-free strike.

Contracts, HTTP endpoints, Durable Object command routing, quote storage, outbox identities, read/export schemas, and presentation types gain the parlay variant. PoolDO startup runs an idempotent `transactionSync` schema migration: inspect `sqlite_master`, rebuild the old `wager` table atomically only when its `CHECK` omits `parlay`, copy explicit columns and original `rowid`, then swap tables; add nullable `settled_odds` to `settlement`. Tests capture deterministic `rowid,*` snapshots before migration and verify the first pass preserves every legacy row and field (apart from the new nullable settlement column), then verify a second pass is idempotent across dependent legs, settlements, quotes, and processed commands.

## User experience

The odds-board tray gains **Build parlay**. ParlayPage mirrors TeaserPage's editing → quoting → review → submit state machine but remains lean:

- selected-leg table and remove controls;
- one whole-share risk input;
- an advisory current-board estimate only; the review snapshot is the authoritative odds/payout;
- explicit same-game `-133` total adjustment in review;
- stale-line recovery and byte-identical retry behavior;
- no point selector, adjusted-line UI, or straight-bet batch behavior.

The compact table-first 2007 visual language, keyboard access, error focus, and per-leg privacy/redaction remain unchanged. My Wagers, Activity, History, exports, corrections, and Rules support `parlay` alongside straight and teaser tickets. `PRODUCT.md` becomes the canonical product source for parlays; the older original design receives a clear supersession note rather than silently retaining contradictory deferred-scope text.

## Validation and testing

Client validation is advisory; HTTP contracts, Worker canonical quote/revalidation, PoolDO placement validation, and settlement are authoritative. Invalid/stale attempts must not mutate accounts, wagers, ledger, outbox, quotes, or processed commands.

TDD coverage includes rational conversion across positive/negative/even/overflow boundaries; the `+250` adjustment; all same-game selection combinations; moneyline proof/strike separation; loss precedence; one-leg and broken-pair repricing; refunds; six-leg caps; legacy seven-leg quote/placement replay and settlement/regrade; forged/stale quote zero-mutation paths; durable table rebuild preservation; exposure across mixed ticket types; settled odds in owner/audit/history reads; redaction; and simplified builder behavior. Local end-to-end tests remain out of scope unless a related failure requires them. Targeted Vitest/Worker suites, typecheck, build, and CI validate the branch.

## Review gates

- Review this design and the detailed implementation plan before coding.
- Run independent specification and code-quality reviews after each implementation slice; resolve material findings before the next slice.
- Before opening the pull request, run final verification and repeat expert whole-branch review/fix/re-review until reviewers converge with no unresolved material findings.
