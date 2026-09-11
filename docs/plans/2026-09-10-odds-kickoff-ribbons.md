# Mobile odds kickoff ribbons

## Approved design
Add a thin date/time ribbon above each contiguous batch of games with the same kickoff on the odds board, mobile only (existing 600px breakpoint). Match My Bets' blue date ribbons, including compact white text and padding. Remove repeated mobile kickoff labels from each matchup; keep desktop Start cells unchanged. Use the existing local kickoff formatter and compare actual timestamps, not formatted labels. Filtering must leave a ribbon above the first remaining game. No betting, selection, API, or ESPN changes.

## Implementation and validation
1. Add focused rendering tests for equal kickoffs, separate times/dates, filtered groups, empty boards and mobile-only CSS.
2. Insert a ribbon row before each kickoff batch, spanning the four visible mobile columns, without changing the paired game rows.
3. Match ribbon styling at the existing breakpoint and remove obsolete per-game mobile kickoff markup/CSS.
4. Run focused unit tests and typecheck; leave E2E to CI. Open an independent PR against main so this can ship separately from ESPN details.
