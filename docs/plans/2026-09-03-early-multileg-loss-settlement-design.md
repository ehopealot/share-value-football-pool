# Early Multi-Leg Loss Settlement Design

**Status:** Approved by the operator on 2026-09-03.

## Problem

Parlays and teasers currently remain open until every leg has a terminal provider result. That all-final gate applies even when an already-final leg is graded as a loss, although one loss makes either ticket irreversibly lost under the accepted rules. Consequently, straight bets and fully completed multi-leg tickets using the same losing event settle while multi-leg tickets with later pending legs keep risk locked.

## Decision

A parlay or teaser settles as a loss as soon as any terminal provider result grades one of its immutable legs as a loss. Wins, refunds, pushes, and void reductions still wait until every distinct event represented by the ticket has a usable terminal result. Straight-wager behavior is unchanged.

Settlement continues to use the accepted line, adjusted teaser line, market, selection, ruleset, and provider event identity stored in the Pool Durable Object. D1 remains only the provider-result source; the PoolDO alarm remains the sole automatic accounting authority.

## Corrections and lifecycle

Early settlement does not stop reconciliation for the ticket's other events. Each newly observed terminal result produces the same append-only reversal-and-replacement flow already used for provider result versions, keeping leg grades and settlement evidence current without minting or burning shares twice.

If the result that caused an automatic early loss is corrected and no other observed leg loses while at least one leg remains pending, the PoolDO appends a reversal, restores the risk to locked shares, and reopens the ticket. A later decisive result settles it again. Partial provider evidence never reopens a commissioner-authored settlement; automatic reconciliation waits for complete provider evidence before replacing such a correction.

A season must not close from zero float or Super Bowl completion while an early-settled multi-leg ticket still has an ungraded leg. This preserves the active authority required for provider corrections and remaining event reconciliation. Once all of those legs are graded, the existing closure rules apply.

## Data and events

No schema migration is required. Existing `wager.status`, per-leg `grade`/`result_version`, immutable `settlement` reversal rows, ledger entries, and settlement outbox events represent the full lifecycle. Reopening uses the existing `SettlementRegraded` event because consumers only use it to refresh an authoritative projection and the event already carries the prior result version.

## Validation

Durable-object regression tests will cover:

- a parlay settling after one losing leg while another leg is pending;
- a teaser settling under the same condition;
- wins/refunds remaining open until all legs finish;
- unchanged retries remaining idempotent;
- additional final legs using reversal/replacement without net accounting changes;
- correction of the only loss reopening and re-locking the ticket;
- another known loss preserving the lost outcome;
- partial provider evidence not reopening a commissioner settlement; and
- early loss not prematurely closing a season.

Rules copy and the superseded parlay design are updated to state the immediate-loss behavior.
