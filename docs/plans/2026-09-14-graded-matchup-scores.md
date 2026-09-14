# Graded Matchup Scores Implementation Plan

**Goal:** Show the final score after each team name on a visible, graded wager leg, for example `Michigan (+5.5) (17) at Oklahoma (10)`.

**Scope and design:**
- Persist nullable home/away score snapshots on each `wager_leg` when that leg is graded. Automatic settlement writes the exact provider result; commissioner regrades write the supplied corrected result. Later corrections replace the snapshot. Pending, void/no-score, and legacy legs have no score pair.
- Add the optional, paired scores to the member-read contract. Read shaping exposes them only with a visible graded leg and both valid values, preserving existing owner/kickoff redaction and allowing zeroes.
- Reuse the shared wager-line formatter in Activity, My Bets, correction summaries, and the archived wager details table. Keep the existing grade wrapper color and selected-term `<strong>` emphasis; score suffixes are added to the corresponding team only after the selected line.
- Cover score formatting for spreads, totals, moneylines, zeroes, missing/ungraded values, durable score/correction propagation, and hidden-leg redaction.

**Validation:** Run focused web, contract, durable, and worker regressions; then typecheck and inspect the diff. Do not run E2E tests.

## Residuals

Already-graded historical legs have no persisted score snapshot, so they intentionally continue to omit scores unless a later correction regrades them. No live-score display or polling behavior is introduced.
