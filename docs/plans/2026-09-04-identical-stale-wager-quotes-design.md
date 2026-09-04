# Identical Stale Wager Quotes Design

## Goal

Allow straight wagers, teasers, and parlays to be placed after the pool command version advances when every user-confirmed wager term remains identical.

## Design

A wager quote remains an immutable record of the terms the member confirmed. Placement must continue to prove that its `quotedCommandVersion` is the version stored with that quote and that its complete canonical placement terms exactly match the stored quote. The Worker continues to revalidate those terms against the current D1 offer snapshot immediately before dispatch to the Pool Durable Object.

The pool's current command version will no longer, by itself, invalidate an otherwise exact wager quote. Instead, the placement transaction runs all current-state checks already enforced by `placeWager`: active season, available shares, side-bet limit, market start, canonical proof, wager rules, and complete ticket validity. This is the atomic equivalent of rebasing an identical quote onto the current command version, without mutating the original quote or introducing a client-side quote/place race.

If any line, odds, selection, payout, risk, ruleset, leg order, or other stored placement term differs, placement still fails with `LINE_CHANGED`. A forged quoted version still fails with `ORDER_QUOTE_STALE`. Current canonical offer changes are rejected by Worker revalidation before the command reaches the Durable Object.

## Testing

Add Durable Object regression coverage for straight, teaser, and parlay quotes. For each type, create an exact quote, advance the pool command version with an unrelated mutation, and assert that placement succeeds. Preserve assertions that altered terms and forged quote versions fail without mutation. Existing Worker offer-revalidation tests continue to prove that actual canonical line changes require reconfirmation.
