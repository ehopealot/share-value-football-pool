# Stale Odds Reload Link Design

## Goal

Give a member a clear recovery action when the Odds board reports a stale feed. The action must refresh the entire browser page so the board and all related member state are fetched again.

## Behavior

`OddsPage` will render a raw `Reload odds` anchor immediately after the existing feed-status sentence only when `board.feed.status === "stale"`. The anchor targets the current browser URL, causing a document navigation rather than a React Router transition or an in-place API fetch.

A full navigation intentionally clears client-only state: selected league and week filters, the unsaved bet slip, notices, errors, and any in-progress UI state. This is an acceptable and deliberate trade-off for a simple, dependable recovery path. The action does not invoke an administrative endpoint, alter offer data, or force the odds provider to poll. It merely asks the browser to load the current page again; the normal odds read then reports the newest authoritative feed state.

The link will not appear for `current`, `provider-error`, `no-offer`, or loading states. Existing server-side availability rules remain authoritative: stale offers continue to prevent wager review and placement until a later normal refresh returns a current feed.

## Testing

A focused Odds page test will assert the stale-only rendering condition and verify the anchor is a plain navigation link to the current URL, not a router link or an odds API mutation. Existing full tests and type checking will confirm no regression to board presentation, accessibility, or the parse/fail-closed feed contract.
