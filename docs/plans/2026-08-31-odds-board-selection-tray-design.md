# Odds board selection tray — design (2026-08-31)

Approved lean design. Goal: compact per-game odds selection with a selections tray that supports batch straight bets and teaser building, with no new server APIs.

## Board

- One row per game (group offers by `eventId`), not one per market.
- Each selectable outcome is a checkbox labelled with full meaning (team/Over/Under + point or price), e.g. `KC −3.5`, `Over 44.5`, `DET +150`.
- Old per-outcome "Select …" buttons, the single straight editor section, and its "Add selection to teaser" button are removed.

## Selection tray

- Item: `{ eventId, market, selection, wagerId, risk }`, persisted in `sessionStorage` per pool slug (`share-pool:tray:<slug>`).
- Identity-only: lines/prices are never stored; tray items resolve against the current board for display and actions. Missing items show "no longer available" and clear on their next action.
- `wagerId` is stable per item across retries (idempotent replay prevents double placement after unknown outcomes). Each review attempt gets a fresh `quoteKey`.
- Per-item risk input (whole shares); validation before review.

## Batch straight flow (existing single-leg APIs only)

State machine: `idle → quoting → reviewing → placing → results`.

1. **Quoting**: each tray item with a valid risk is resolved against the board and quoted sequentially (`api.quoteStraight`). Quote failures are recorded per item; others continue.
2. **Reviewing**: one screen lists all frozen quotes (terms + risk). One "Place all" button places each sequentially (`api.placeCommand`) with per-item outcome capture.
3. **Results**: per-item placed/failed with reason. Placed items leave the tray; failed items stay (line changed, market locked, quote stale, insufficient shares, unknown transport outcome — retry keeps the same `wagerId`). Summary count links to My wagers.

## Teaser flow

- "Add spreads/totals to teaser" pushes eligible resolved items through the existing `addTeaserLeg` rules into the existing teaser slip; successfully added items leave the tray. Moneyline items are ineligible and simply remain.

## Code

- New pure module `src/web/selection-tray.ts` (toggle, eligibility, resolution, persistence).
- `OddsPage.tsx` rewritten around the state machine; `styles.css` gains compact board/tray styles.
- Accessibility: checkbox labels carry full meaning; the tray is a labelled region; results announce per item.

## Tests

- Unit tests for `selection-tray.ts` and extracted pure helpers.
- Page-helper tests updated.
- E2E specs drive checkboxes, tray risks, batch review/place, and one partial-failure case via existing local fixtures/barrier.
