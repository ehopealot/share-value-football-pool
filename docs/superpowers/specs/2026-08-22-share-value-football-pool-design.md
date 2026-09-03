# Share Value Football Pool — Design Specification

**Date:** 2026-08-22

**Status:** Approved by the operator on 2026-08-22; parlay deferral and fresh teaser 2–7-leg rules are superseded by [`2026-09-02-parlays-six-leg-cap-design.md`](../../plans/2026-09-02-parlays-six-leg-cap-design.md). Its seven-leg teaser table remains historical settlement/regrade compatibility only.
**Product record:** [`PRODUCT.md`](../../../PRODUCT.md)

## 1. Objective

Build a private, reusable NFL and college-football paper-trading pool inspired by OfficeFootballPool's former True Share format. Members wager virtual shares against a virtual sportsbook. Winnings create shares, losses destroy shares, and one common share price moves inversely with the outstanding float. The application never accepts or transfers real money.

The first release includes:

- global user accounts;
- private password-joined pools;
- reusable pools with archived seasons;
- commissioner-issued virtual share orders;
- straight spread, total, and moneyline wagers;
- fixed-rule 6, 6.5, 7, 7.5, and 10-point teasers;
- automated line ingestion and result settlement;
- standings, immutable activity history, and per-leg delayed pick disclosure;
- a deliberately compact 2007-era web interface.

Parlays, live/in-game betting, real payments, public pools, chat, native apps, and commissioner-configurable odds or payout tables are outside this release.

## 2. Architecture Decision

### 2.1 Options considered

1. **D1 only.** Simplest storage topology and easiest global queries, but balance checks, simultaneous wagers, settlement retries, and commissioner orders would require careful optimistic concurrency in a database that is also serving unrelated global work.
2. **One SQLite Durable Object per pool, with D1 for global data — selected.** Each pool has a globally unique, serialized command boundary and a local transactional ledger. D1 remains appropriate for global identity, slug lookup, shared sports data, and disposable projections.
3. **Durable Objects only.** Strong pool-local behavior, but global accounts, user-to-pool discovery, unique slugs, shared game data, and scheduled provider ingestion become awkward and duplicative.

### 2.2 Selected topology

- **Cloudflare Worker:** HTTP application, Hono routes, authentication integration, static assets, odds ingestion cron, and Durable Object routing.
- **D1:** Better Auth tables; global profile references; unique pool-slug registry; user-to-pool and active-season projections; system-wide games, markets, canonical offers, results, and ingestion state.
- **One SQLite-backed Durable Object per pool:** authoritative pool configuration, password hash, membership, commissioner role, seasons, share accounting, wagers, reveal state, settlement, audit history, and outbox.
- **Cloudflare Queues:** reliable delivery of pool-directory projections and result notifications when asynchronous fan-out is needed. The initial implementation may use a queue consumer with small batches; no request path waits for a projection.
- **Cloudflare Turnstile:** bot mitigation on public signup, login abuse, pool creation, and join attempts. It is not an authentication system.

There is no transaction spanning D1 and a Durable Object. Every cross-store operation is an idempotent command plus projection/outbox workflow. A projection may be stale; it is never consulted for wager authorization, balance calculation, or settlement.

## 3. TypeScript Stack

- TypeScript in strict mode throughout.
- React with Vite and the Cloudflare Vite plugin for the browser application.
- Hono for Worker routing and middleware.
- Better Auth using its Drizzle adapter and D1 for email/password accounts and database sessions.
- Drizzle for D1 schema and migrations. Durable Object accounting uses reviewed, parameterized SQLite statements directly so transaction boundaries remain explicit.
- Zod at every external and cross-component boundary.
- BigInt fixed-point domain arithmetic; SQLite stores fixed-point values as canonical integer text where values can exceed safe JavaScript integers. SQLite `REAL` and JavaScript `number` are forbidden for share/value accounting.
- `@noble/hashes` scrypt for pool join-password hashing. Better Auth owns account-password hashing.
- Vitest and Cloudflare's Workers test pool for unit/integration tests; Playwright for the critical browser journeys.
- Plain authored CSS. No Tailwind, visual component suite, CSS-in-JS framework, or default modern design system.

### 3.1 Authentication behavior

Accounts use email/password through Better Auth. Production email verification and password reset use a small `EmailSender` boundary with a Resend adapter; local/test environments use a non-delivering development mailbox. OAuth and passkeys are not first-release requirements, but account IDs are provider-neutral.

The application delegates password hashing, session rotation, CSRF/session-cookie behavior, verification tokens, and password-reset tokens to Better Auth. Application code owns only pool membership and the separate pool join password.

## 4. Authoritative Data Boundaries

### 4.1 D1 global tables

- Better Auth-generated user, credential/account, session, verification, and migration tables.
- `pool_registry`: immutable pool ID, unique normalized slug, Durable Object name, creator, created time, and deletion state.
- `membership_projection`: user ID, pool ID, pool name, role, status, and projection version for the account home page only.
- `season_projection`: pool ID, season ID, label, state, opened/closed times, and projection version.
- `sports_event`: provider-neutral event, league, teams, UTC start, status, score, provider IDs, and correction version.
- `market_offer`: current canonical spread/total/moneyline offers and retrieval metadata.
- `odds_ingestion`: provider cursor, quota observations, poll times, failures, and canonical-book availability.
- `projection_delivery`: idempotency and retry records for DO outbox delivery.

### 4.2 Per-pool Durable Object SQLite tables

- `pool`: name, slug, commissioner user ID, signups-open flag, password hash/version, active season ID, and command version.
- `member`: user ID, display-name snapshot, active/suspended status, joined time, and role. Exactly one active commissioner exists.
- `season`: label, state (`draft`, `active`, `closed`), opened/closed metadata, close reason, notional value, total float, commissioner-configured default initial-order mode/amount, and ruleset versions.
- `share_account`: season/member available shares, locked shares, and row version.
- `share_order`: commissioner-entered mode, requested amount, executed notional value, executed share quantity, price snapshot, member, reason, idempotency key, and timestamp.
- `ledger_entry`: append-only accounting journal with event type, account, available delta, locked delta, float delta, notional-value delta, causation ID, reversal link, actor, and timestamp.
- `wager`: owner, season, type, integer risk, accepted profit odds, status, confirmation time, settlement/regrade versions, and ruleset version.
- `wager_leg`: event, league, market/selection, original line and odds snapshot, teaser adjustment, adjusted line, event start snapshot, reveal time, grade, and result version.
- `settlement`: immutable settlement/reversal events with calculated return/profit and source-result snapshot.
- `outbox`: projection/result messages with attempts and delivery state.
- `processed_command`: idempotency key, command type, response digest, and retention time.

The ledger is the audit record. Cached balances and season totals are transactionally maintained projections and are continuously checked against ledger invariants.

## 5. Share Accounting

### 5.1 Fixed-point representation

- One share is `1_000_000` share micros.
- One virtual dollar is `1_000_000` value micros.
- All multiplication/division uses BigInt with explicit round-half-even to one micro.
- Wager risk must be a positive whole-share multiple. Fractional balances remain owned and included in float but cannot be selected as risk.
- UI displays balances and transaction outcomes to two decimals and share price to four decimals by default, with exact six-decimal values available in details/export.

### 5.2 Price and season initialization

For a nonempty season:

`share price = notional pool value / outstanding share float`

A draft or newly active season with zero value and zero float quotes `$1.00/share`. The first commissioner order executes at `$1.00`.

### 5.3 Commissioner share order

The commissioner chooses a member and enters either:

- virtual-dollar value, with shares calculated; or
- share quantity, with virtual-dollar value calculated.

A season may save either form as its default initial-order amount so the commissioner can populate an order consistently for new members. The default is only a form convenience: it never credits a member automatically, and the commissioner confirms every execution.

The confirmation response includes both values and a short-lived price/version token. Execution occurs inside one DO transaction. If the season version changed, the server returns a new quote and requires reconfirmation. Execution increases notional value and float proportionally at the captured price. Fixed-point rounding may move the unrounded mathematical price by less than one share/value micro; the displayed execution price remains stable, and the invariant test bounds that error.

An order can be corrected only by an explicit reversing order. No order is edited or deleted. There are no payment, paid/unpaid, invoice, or withdrawal states.

### 5.4 Wager lifecycle

Placement transfers risk from `available` to `locked`; total float is unchanged.

- **Win:** return locked risk to available and mint the calculated profit into available/float.
- **Loss:** destroy locked risk and reduce float.
- **Push/void:** return locked risk; float is unchanged.
- **Regrade:** atomically reverse the prior settlement and apply the replacement result, preserving both records.

A transaction refuses any action that would produce a negative available or locked balance. If settlement reduces total float to zero, the season closes immediately with reason `float_exhausted`; no later order or wager is accepted.

### 5.5 Ranking

Member holdings are `available + locked`. Member notional value is holdings multiplied by the common share price. Standings sort by holdings descending, then earliest attainment time, then display name. Because every member has the same price, holdings and notional value produce the same primary ordering.

## 6. Market and Wager Rules

### 6.1 Straight wagers

- Sides and totals pay fixed `+100`, regardless of provider vig.
- Moneylines use the canonical source's accepted American odds.
- Exact odds/line, provider event ID, canonical bookmaker, and retrieval time are copied into the pool DO at confirmation.
- A line must be current, offered, and before the provider event start. Existing wagers never move with later odds.
- If the offer changed after the browser built the slip, confirmation returns `LINE_CHANGED` with the replacement and requires explicit reconfirmation.
- Tied spreads/totals push. A tied two-way moneyline event is void unless the selected market explicitly offered a draw outcome, which is not part of first-release football markets.
- Canceled/no-contest games are void. Postponed games retain action only when the canonical provider preserves the same event ID and starts within 48 hours; otherwise they are void.

### 6.2 Teaser selection

- Allowed adjustments: 6, 6.5, 7, 7.5, and 10 points.
- Legs may mix NFL/NCAA, sides/totals, games, and kickoff times.
- Moneylines cannot be teaser legs.
- The same exact market selection may appear only once. Opposing sides or both over and under from the same market are rejected. A side and total from the same game are allowed.
- The adjusted line moves in the selected member's favor: favorite toward zero, underdog away from zero, over downward, under upward.
- Every leg snapshots original and adjusted terms before the earliest included event begins.

### 6.3 Fixed Share Pool teaser table

The application publishes one immutable `SHARE_POOL_2026_V1` house table, derived from a long-running BookMaker football teaser table and normalized to one system-wide mixed-league rule. It is canonical for this application, not represented as an industry-universal table.

| Legs | 6 pts | 6.5 pts | 7 pts | 7.5 pts | 10 pts |
|---:|---:|---:|---:|---:|---:|
| 2 | -120 | -130 | -140 | -160 | — |
| 3 | +150 | +135 | +120 | +105 | -120 |
| 4 | +235 | +215 | +200 | +140 | — |
| 5 | +350 | +320 | +300 | +235 | — |
| 6 | +550 | +500 | +475 | +325 | — |
| 7 | +800 | +700 | +600 | +445 | — |

Thus regular teasers allow 2–7 legs and 10-point teasers require exactly 3 legs. The accepted American price and ruleset ID are stored on the ticket. A later system-wide ruleset ships under a new ID and affects only new tickets.

### 6.4 Teaser grading

Grade every leg against its accepted adjusted line.

1. If any leg loses, the entire risk loses.
2. Otherwise, remove pushed or void legs.
3. If the remaining winning-leg count is valid in the same point-adjustment table, reprice at that row and settle as a win.
4. If every leg pushed/voided, or the remaining winners are fewer than the minimum valid row, refund the risk.

For a 10-point three-leg teaser, one push leaves too few legs and therefore refunds if the other legs win; any loss still loses.

## 7. Odds and Results

### 7.1 Provider boundary

`OddsProvider` exposes provider-neutral operations for leagues, events, offers, scores, statuses, and corrections. The first production adapter targets **The Odds API** because it documents NFL/NCAAF keys, moneyline/spread/total markets, and scores over ordinary HTTPS. A deterministic fixture adapter powers local development and tests.

SportsLine's publicly delivered GraphQL data may be evaluated later, but the launch does not depend on reverse-engineering an undocumented endpoint. It may be added only if access controls are not bypassed and its terms permit server-side retention/display.

### 7.2 Canonical bookmaker policy

The service, not a commissioner, owns one ordered policy:

1. DraftKings
2. FanDuel
3. BetMGM
4. Caesars

For each event, ingestion selects the first bookmaker that supplies all requested market data for that market. The UI displays the actual source and timestamp. It never chooses a selection-specific best price. If no canonical book offers a market, that market is unavailable.

The ordered list is deployment configuration but is system-wide and versioned in each odds snapshot. Changing it affects only future offers and wagers.

### 7.3 Polling and staleness

A scheduled Worker adapts polling frequency to event proximity and configured provider quota:

- more than 24 hours before start: no more than every 6 hours;
- 1–24 hours: every 30 minutes;
- within 1 hour before start: every 5 minutes;
- started but not final: scores/status every 2 minutes when quota permits;
- final: one reconciliation poll after 15 minutes and one after 24 hours.

The exact schedule may back off automatically when quota headers demand it. An offer older than its proximity window is marked stale and cannot be accepted. Provider outages never alter accepted wagers; they delay new wagers or settlement and display an explicit feed status.

### 7.4 Settlement delivery

Odds/result ingestion writes D1 first. Active pool DOs use alarms to inspect shared final/correction versions for events referenced by open wagers. Settlement is idempotent by `(wager, result_version)`. A later corrected final score triggers an audited regrade rather than an overwrite.

A season identifies the Super Bowl from the provider's NFL postseason metadata and event name, with a commissioner-visible confirmation once scheduled. Closure waits for its final result and for every season wager to leave `open`.

## 8. Accounts, Pools, and Seasons

### 8.1 Account and home

A person may create an account before joining or creating any pool. The authenticated home lists projected memberships and links directly to each pool. Direct pool access always asks the pool DO for authoritative membership.

Any account may create a pool in this release. Pool creation goes through `SeasonEntitlementService`, which currently returns an allowed free entitlement. A future paid-per-season implementation can replace that service without touching pool accounting.

### 8.2 Joining

A pool URL uses a unique, case-insensitive slug.

- Existing active member: enter pool.
- Signed-out visitor: preserve destination and require signup/login.
- Signed-in nonmember with signups open: show pool name and join-password form.
- Signed-in nonmember with signups closed: show a closed message without exposing pool data.

A correct password creates active membership with zero shares. Join attempts are rate-limited and Turnstile-protected after a low failure threshold. Pool passwords are scrypt hashes with independent salts and can be rotated without removing members.

### 8.3 Commissioner authority

Exactly one member is commissioner. The commissioner can:

- rename the pool and rotate its password;
- open/close signups;
- open the next season;
- configure the season's default initial-order amount and execute/reverse individual share orders;
- suspend or restore members while preserving history;
- void/regrade wagers with a required reason;
- transfer the commissioner role to another active member.

The commissioner cannot view unstarted selections, edit ledger history, create overlapping seasons, reopen a closed season, or place wagers for another member.

### 8.4 Season lifecycle

- `draft`: created by commissioner, zero value/float, quote `$1`, no wagers.
- `active`: orders and wagers permitted; one active season maximum.
- `closed`: immutable except append-only administrative annotations/export.

Members persist into the draft with zero season holdings. Opening is manual. Closure is automatic on Super Bowl completion/all wagers settled or zero float. Historical seasons remain member-only.

## 9. Privacy and Reveal Policy

Hidden selection data is removed by server response shaping, not concealed with CSS or client state.

- A straight selection is visible to its owner immediately and to other members only at its event's accepted start time.
- Each teaser leg is independently visible to its owner immediately and to others only when that leg starts.
- Before reveal, other members may see no selection, team, market, line, event, or future-leg count that leaks the pick. They may see aggregate open risk only if doing so cannot identify a ticket; the first release omits opponent open-risk aggregates for simplicity.
- The commissioner receives the same redacted views as every other member.
- Settlement workers access full encrypted transport/storage data as application infrastructure, not through a human administrative route.

Audit and API tests explicitly verify that unauthorized JSON never contains hidden fields.

## 10. Web Interface

### 10.1 Visual direction

The interface is an **Operate** surface modeled on the useful density of a 2007 private sports site. It uses a centered, mostly fixed desktop canvas that becomes fluid on narrow screens; dark navy and medium blue navigation bars; gray table fills; white content; orange for calls to action; Arial/Verdana workhorse typography; square borders; underlined text links; native-shaped controls; and compact spacing.

It explicitly excludes rounded corners, drop shadows, glass, decorative gradients, floating cards, oversized marketing typography, icon-tile dashboards, and ornamental animation. Modern behavior remains underneath: semantic HTML, visible focus, responsive tables, error summaries, reduced-motion respect, and WCAG 2.2 AA contrast.

Archived OfficeFootballPool pages and their navy/blue/orange table hierarchy are visual evidence. Their trademarks, logo, exact copy, obsolete scripting, inaccessible behaviors, rounded promotional buttons, and shadow treatments are not copied.

### 10.2 Primary routes

- `/`: signed-out explanation/login links or signed-in pool list.
- `/sign-up`, `/login`, `/forgot-password`, `/reset-password`.
- `/pools/new`.
- `/p/:slug`: pool overview or join gate.
- `/p/:slug/odds`: league/date-filtered odds board and straight bet flow.
- `/p/:slug/teaser`: teaser builder, adjusted-line preview, payout, and confirmation.
- `/p/:slug/my-wagers`: open and settled personal tickets.
- `/p/:slug/standings`: holdings, locked/available shares, price, notional value, gain, and rank.
- `/p/:slug/activity`: member-visible share orders and revealed/settled wager ledger.
- `/p/:slug/rules`: current season rules, fixed payout table, data source, and feed status.
- `/p/:slug/history/:season`: read-only archived season.
- `/p/:slug/admin/*`: commissioner members, share orders, season, corrections, and settings.

### 10.3 Interaction requirements

- Every risk/return and order quote has a plain-language confirmation page.
- Price/line changes never silently update a confirmation; they require another confirmation.
- Odds tables are keyboard navigable and preserve headers when horizontally scrolled on mobile.
- Win/loss/push use text labels and symbols in addition to color.
- Feed stale/error state appears beside the odds timestamp and disables only affected new actions.
- Empty membership, zero-share, no-active-season, no-odds, provider-error, and closed-season states each explain the next available action.

`DESIGN.md` will be generated from the finished implementation, not from this pre-build intention, as required by the visual workflow.

## 11. API and Command Model

Browser mutations carry an idempotency key. The Worker authenticates the session, validates input, resolves slug to pool ID, and forwards identity plus command to the pool DO. The DO repeats membership/commissioner authorization and executes a SQLite transaction.

Representative commands:

- `CreatePool`, `JoinPool`, `UpdatePoolSettings`, `TransferCommissioner`
- `CreateSeason`, `OpenSeason`
- `QuoteShareOrder`, `ExecuteShareOrder`, `ReverseShareOrder`
- `QuoteStraightWager`, `PlaceStraightWager`
- `QuoteTeaser`, `PlaceTeaser`
- `SettleEventVersion`, `VoidWager`, `RegradeWager`
- `ReadPoolView`, `ReadStandings`, `ReadActivity`, `ReadWagers`

Every success returns the resulting command version. Repeating an idempotency key returns the original response. Conflicting reuse returns `IDEMPOTENCY_CONFLICT`.

## 12. Security and Abuse Controls

- Better Auth session and cookie recommendations are followed; production cookies are secure, HTTP-only, and SameSite Lax or stricter.
- Origin/CSRF checks apply to every mutation.
- Pool and member authorization is repeated inside the authoritative DO.
- Pool passwords use scrypt, constant-time verification, rotation versions, Turnstile escalation, and rate limits keyed by IP/account/pool.
- Hidden picks are server-redacted and covered by authorization tests.
- All SQL is parameterized. User text is rendered as text, never raw HTML.
- Odds keys, auth secrets, Turnstile secrets, and email credentials are Worker secrets and never browser variables.
- Logs use IDs and command types, not credentials, full session tokens, pool passwords, or hidden selections.
- Commissioner corrections and transfers require recent authentication and an audit reason.
- Backups/recovery rely on D1 and Durable Object recovery facilities plus periodic encrypted exports of ledger/audit data to R2 when configured.

## 13. Failure Handling

- **Odds provider unavailable:** show last successful poll and error; stale markets reject new quotes; accepted wagers remain intact.
- **Result delayed:** wager remains open and shares locked; alarms retry with bounded backoff.
- **Provider correction:** reverse and reapply settlement by result version.
- **D1 projection delayed:** home list may lag; direct slug/member access remains authoritative. Outbox retries repair it.
- **Duplicate request/retry:** idempotency returns the original result.
- **DO unavailable:** Worker returns a retryable service error; no local speculative balance update.
- **Line starts during confirmation:** placement fails closed and returns `MARKET_LOCKED`.
- **Commissioner mistake:** append reversing event; history remains visible.
- **Zero float:** close season immediately and reject all subsequent commands except reads/exports.

## 14. Testing Strategy

Implementation follows test-driven development.

### 14.1 Domain tests

- American odds payout conversion and fixed-point rounding.
- Side/total/moneyline grading, pushes, cancellations, postponements, and corrections.
- Every teaser adjustment, table row, mixed-leg ticket, loss precedence, push reduction, and below-minimum refund.
- Share order price preservation within one micro.
- Ledger/balance/float/notional invariants through randomized command sequences.
- Fractional remainder ownership with whole-share stake enforcement.
- Zero-float closure.

### 14.2 Durable Object integration tests

- Concurrent wager attempts cannot overspend.
- Concurrent order/wager quote versions force reconfirmation.
- Idempotent placement and settlement retries mint/burn exactly once.
- Regrade reverses precisely.
- Commissioner permissions and transfer uniqueness.
- Membership projection failure does not weaken DO authorization.
- Hidden selections never leave read APIs before each start time, including commissioner reads.

### 14.3 Provider and Worker tests

- Recorded provider fixtures normalize NFL/NCAAF events and all three markets.
- Canonical bookmaker fallback is deterministic and never selection-shops.
- Staleness and kickoff lock behavior.
- Cron quota backoff, final reconciliation, and correction delivery.
- Authentication, join rate limits, pool password rotation, and Turnstile verification boundaries.

### 14.4 Browser tests

- Unattached signup, pool creation, password join, and closed-signup denial.
- Commissioner order by value and by shares.
- Straight and mixed teaser confirmation, changed-line reconfirmation, and integer-risk validation.
- Per-leg reveal to another member.
- Automatic standings changes and season archive.
- Desktop and mobile keyboard/accessibility smoke checks.

## 15. Delivery and Deployment

The repository will include:

- local Wrangler D1/DO/Queue configuration and migrations;
- fixture odds data and deterministic seed commands, so the complete product runs without external keys;
- `.dev.vars.example` with non-secret variable names;
- documented creation of D1, Queue, Durable Object migration, secrets, and cron schedules;
- production health endpoints for app, D1, DO, odds feed, and queue lag;
- no automatic production deployment without an explicitly configured Cloudflare account and secrets.

Initial implementation is complete when all critical flows operate against local Cloudflare emulation, accounting/concurrency/privacy tests pass, production build succeeds, the vintage interface passes its desktop/mobile finish review, and deployment instructions identify the remaining operator-supplied provider/auth/email secrets.

## 16. Deferred Work

- Real billing for season activation.
- Parlays, live bets, props, or sports beyond NFL/NCAA football.
- Public pools, public standings, invitations without pool password, or membership requests.
- Multiple commissioners.
- Commissioner-custom payout tables or odds-source selection.
- SportsLine undocumented GraphQL integration.
- Native mobile applications.
- Cash value, deposits, withdrawals, prizes, or payment reconciliation.

## 17. Source Notes

The following informed decisions but do not grant permission to copy branding or redistribute third-party data:

- Archived OfficeFootballPool Share Pool landing/tour pages (2010–2015), recovered through the Internet Archive, for True Share behavior and period interface evidence.
- Archived BookMaker article `Football teaser & parlay payouts` (capture 2020-09-23) for the selected 6/6.5/7/7.5/10-point table structure.
- Current The Odds API documentation for NFL/NCAAF odds and score endpoint feasibility; plan limits and data-display/retention terms must be confirmed before production use.
- Cloudflare Durable Objects SQLite, D1, migrations, Workers, Queues, Turnstile, and testing documentation; limits must be rechecked at deployment time.
