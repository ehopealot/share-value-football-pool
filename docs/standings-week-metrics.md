# Standings weekly metrics

The Standings week picker defaults to **All weeks**. A selected Tuesday–Monday Pacific betting week replaces only the displayed **SVG** and **Risked** values; rank, holdings, current share price, and notional value remain the active-season values.

## Accounting interpretation

Weekly windows are timestamp windows: the Pacific week start is inclusive and the next Pacific week start is exclusive. The current week includes entries timestamped exactly at the authoritative Pool Durable Object read time (week-to-date). Because stored timestamps have millisecond precision, its exclusive query cutoff is one millisecond after that read time; future entries remain excluded.

- **Risked** is the sum of stakes for wagers whose authoritative `confirmed_at` falls in the window and whose current status is not `refunded`. This mirrors the season-wide Risked rule. It uses placement time, not wager kickoff time, and publishes only a per-member aggregate—never selections or legs.
- **SVG** is `SVG(at window end) - SVG(at window start)`. Each boundary snapshot is reconstructed from immutable accounting timestamps: member holdings and pool float/notional come from `ledger_entry`; member issued basis comes from `share_order`; the boundary share price and holding value use the same round-half-even calculations as season standings. A ticket whose current status is `refunded` is omitted from this weekly reconstruction along with every settlement and correction-reversal ledger entry it caused, so it cannot reprice another member's weekly SVG. The season-wide view remains actual accounting. This captures all other authoritative value change during the window, rather than treating wager kickoff P&L as accounting gain.

## Residuals

A later refund removes its stake from the historical week because Risked intentionally follows current non-refunded status, matching the all-season definition. Historical SVG depends on complete immutable ledger and share-order history; legacy/manual database mutations without corresponding accounting records cannot be reconstructed and therefore are not represented in weekly SVG. The refunded-ticket reconstruction retains actual share-order and order-reversal quantities and values; it deliberately does not invent alternate orders from a hypothetical counterfactual quote.
