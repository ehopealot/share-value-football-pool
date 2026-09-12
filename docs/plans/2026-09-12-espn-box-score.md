# ESPN box score on the matchup page — 2026-09-12

## Goal
The matchup details page becomes a live box score once a game starts, linked from
Activity/My Bets (and the existing odds-board links). Links are not underlined.

## Behavior
- **Pregame** (before kickoff): current view — records, current-season stats, recent results.
- **Live**: game-state banner (quarter, clock, score) + quarter-by-quarter breakdown,
  refreshed every 60 s while the page is open.
- **Final**: final score + quarter breakdown + team stats. No polling.

## Data flow
- One endpoint, `GET /api/p/:slug/matchups/:eventId/box` (member read, shared rate limiter).
- Worker: scoreboard payload (already used for identity matching) supplies status, scores,
  and per-quarter linescores; the `summary?event=` endpoint is fetched **only for final**
  games to supply team stats (`boxscore.teams[].statistics`, curated label list).
- Cache API TTL is **60 s** (vs. 15 min for pregame details), still salted per deploy.
- Quarter labels: Q1–Q4, then OT, 2OT…

## Client
- `MatchupDetailsPage` fetches matchup + box together. `state: live|final` replaces the
  pregame sections with the box view; a 60 s interval refetches while live.
- Activity and My Bets wrap each leg's wager line in a link when the leg is in the
  current Pacific week (same gate as the odds board). `.matchup-link` removes underline.

## Residuals
- Box scores are current-week only (matches link gating and upstream freshness).
- `sports_event` status is not used to gate the box route; the ESPN state decides.
