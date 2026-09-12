# ESPN Matchup Details Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Let members open an in-app, mobile-friendly active-week matchup page with ESPN records, season comparison stats, kickoff/venue, and recent results.

**Architecture:** The authenticated Worker resolves a requested canonical odds event from D1, rejects events outside the current Pacific Tuesday–Monday week, and retrieves a normalized ESPN view model server-side. It validates ESPN's scoreboard candidate by exact date, home/away sides, and conservative aliases before fetching each matched team's stats and schedule. A Cloudflare Cache API entry keyed by league, both canonical teams, and UTC game date caches only the normalized blob; no D1 schema is added. The browser opens a route containing the opaque odds event ID and keeps selection-tray storage untouched.

**Tech Stack:** Hono on Cloudflare Workers, Cache API, ESPN site API, Zod, React Router, Vitest, existing CSS tokens and betting-week helpers.

---

### Task 1: Define the server-safe ESPN lookup

**Files:**
- Create: `src/services/espn-matchup.ts`
- Test: `tests/espn-matchup.test.ts`

1. Write tests for exact same-date/team-side lookup, explicit aliases, rejected ambiguous/wrong candidates, cache keying, cache hits, and upstream failures.
2. Run `npx vitest run --project=node tests/espn-matchup.test.ts` and confirm the missing module/test failure.
3. Implement a bounded ESPN client which uses only fixed ESPN URLs, validates untrusted JSON into the small browser view model, and returns missing data rather than a mismatched game.
4. Re-run the focused test and confirm it passes.

### Task 2: Add the authenticated active-week API boundary

**Files:**
- Modify: `src/worker/routes.ts`
- Modify: `src/worker/app.ts`
- Modify: `src/index.ts`
- Modify: `src/index.local.ts`
- Test: `tests/worker/espn-matchup.test.ts`

1. Write Worker route tests for member authorization, canonical event lookup, active-week rejection, cached response behavior, and upstream unavailable response.
2. Run the focused Worker test and confirm it fails because the endpoint is absent.
3. Add `GET /api/p/:slug/matchups/:eventId`, authorize it like the board, select the canonical scheduled event, and apply `inWeek(..., weekStartOf(now))` using the real current week—not any browser-selected week.
4. Wire production to `caches.default` and local composition to the same server-side dependency; do not alter migrations.
5. Re-run the focused Worker test and confirm it passes.

### Task 3: Add the in-app page and odds-board links

**Files:**
- Create: `src/web/pages/MatchupDetailsPage.tsx`
- Modify: `src/web/api.ts`
- Modify: `src/web/router.tsx`
- Modify: `src/web/pages/OddsPage.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/web-matchup-details.test.ts`

1. Write tests that the board renders a details link only when the game is in the actual current week, not merely the selected week, and that the page exposes accessible loading, unavailable, back, records, stats, and recent-results states.
2. Run the focused node tests and confirm the behavior fails before implementation.
3. Render the compact side-by-side page with existing layout/colors/touch targets; use a normal link so back navigation returns to the unchanged odds page and its local selection tray remains intact.
4. Re-run focused tests and confirm they pass.

### Task 4: Verify and commit

**Files:** all changed files above.

1. Run focused non-E2E tests, `npm run typecheck`, and `npm run build`.
2. Review the diff against the goal: no client ESPN call, no migration, no inactive-week route/link, no fuzzy match fallback.
3. Commit the implementation on `feat/espn-matchup-details` with no staged files left.
