# Member Profile Pages — Design

Date: 2026-09-06 · Operator request: per-member profile pages linked from the standings, activity, and message-board pages.

## Goals

1. Every member display name on **Standings**, **Activity**, and the **Message board** links to that member's profile page.
2. The profile shows season stats, plus the selected week's in-process and settled bets. Unstarted tickets stay hidden (kickoff privacy is unchanged).
3. A week selector lists every season week (Week 1 through the current Eastern week, plus any week carrying the member's bets), defaulting to the current week. Weeks without displayable bets show "No bets this week."; weeks whose only tickets are unstarted show "Selections not visible yet."

## Non-goals

- No backend or contract changes. The page reuses `GET /api/p/:slug/activity` (viewer-redacted wagers) and `GET /api/p/:slug/view` (member directory, active season). The PoolDO redaction policy (`owner-or-started`, `hiddenLegCount`, withheld `riskMicros`/`acceptedOdds` for unstarted non-owner tickets) remains the single privacy boundary.
- No closed-season profiles. Stats and bet lists are scoped to the active season; without one the page says so.

## Route & data

- Route: `/p/:slug/member/:memberId` → `MemberProfilePage`.
- Data: `api.activity(slug)` + `api.poolView(slug)` in parallel. Wagers are filtered client-side to `memberId` and `view.activeSeason.id`.
- Unknown `memberId` renders a not-found error state. The member's display name and role come from `view.members`.

## Stats (active season)

Each settled ticket counts as one pick regardless of leg count (multis = one pick). Refunds are excluded from W–L and never displayed as a count.

- Season record: W–L over all settled wagers.
- Straight, Teasers, and Parlays records: W–L per `type`.
- Season P&L: exact sum of `performanceMicros` across the member's season wagers (open tickets contribute 0), formatted with the Activity share convention, e.g. `+12.50 shares`.

## Week view

- Week identity reuses the shared Tuesday–Monday Eastern `weekStartOf` domain.
- A wager is displayed for a week when it is settled (`status !== "open"`) or has at least one leg with `eventStartsAt <= now`. Open tickets with no started legs are omitted for every viewer, including the owner (owners still have My Bets).
- Displayed wagers render in two sections — "In process" and "Settled" — reusing the Activity member-section table (start times, graded legs, stake, P&L) with section ribbons in place of the member name. The section sorts its own input by kickoff anchor on mobile, so callers never rely on server ordering.
- Empty week: "No bets this week." A week carrying only unstarted tickets shows "Selections not visible yet." (bet existence is already public on Activity).
- Week enumeration covers every season week through the current one; a clock absurdly far past the anchor keeps the most recent bounded window (80 weeks) always including the current week, never silently dropping it. The skipped enumeration start is snapped into its intended Eastern week with half a week of slack, so DST drift cannot emit an 81st week.

## Links

- `StandingsTable` gains an optional `memberProfilePath(userId)` prop; Standings passes it so names link. Default behavior (plain names) is unchanged for non-router render contexts.
- Activity ribbons: `MemberActivitySection` gains optional `title`/`detail` props; the Activity page passes the member name as a `Link`. Defaults preserve existing markup.
- Message board: the page refreshes a display-name → `memberId` directory from `poolView.members` alongside every board load; a name links only when exactly one member matches (names are not unique) and only while the directory's slug and pool command version match the displayed board snapshot. Failed or superseded refreshes degrade to plain names, never mislinked ones.

## Styling & accessibility

Table-first, square borders, no new visual vocabulary: stats use the existing `table-ribbon-section`/`table-ribbon` pattern like Overview's "Current account". Ribbon links are white-on-navy with the dark-surface focus token. Headings, focus states, and the week `<select>` mirror the Activity page.

## Route lifecycle

Both the profile and the message board mount their stateful body in a child keyed by route identity (profile: pool slug + member id; board: pool slug), so React Router reuse can never render one pool's data, errors, or author links under another route, and a post/reply continuation from a previous pool can only ever touch its own unmounted instance. The profile load effect additionally resets data, error, and selected-week state and ignores superseded responses.

## Testing

- `tests/web-profile-presentation.test.ts`: behavior tests for records (multis = one pick, refunds), week option generation (all season weeks + bet weeks, descending), week split (unstarted omitted, partially started kept, settled kept), and P&L sums.
- `tests/web-profile-page.test.ts`: source/behavior coverage for the route, week selector defaulting to the current week, stats table, sections, and the week notice states.
- Update `tests/web-activity-page.test.ts` for the generalized ribbon. CI runs the unit suite and typecheck; e2e stays in CI only.
