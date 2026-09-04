# Commissioner Banner Notice Design

## Goal

Give a pool commissioner one durable, plain-text notice that appears in a noticeable, accessible banner immediately above the primary navigation on every joined-member pool route. The notice persists until the commissioner explicitly clears it.

## Scope and authority

The notice is a dedicated nullable field in the PoolDO's authoritative pool state. It is not derived from Message Board announcements, stored in browser state, or exposed through the pre-join/closed pool-entry route. This keeps an old announcement from accidentally becoming a permanent banner and prevents unauthenticated visitors from reading commissioner-authored text.

Only the current active commissioner may set, replace, or clear the notice. The PoolDO validates and persists the change as an idempotent settings command; the HTTP boundary uses strict request and response contracts. The browser may offer controls only to a commissioner, but server authorization remains decisive.

## Data flow

`ReadPoolView` adds `pool.commissionerNotice: string | null`. It remains the one member-authorized snapshot used by `Layout` for the pool navigation ribbon, so rendering the banner does not introduce a second client fetch or a browser-owned source of truth.

`UpdatePoolSettings` gains an optional notice field. A nonblank trimmed string sets/replaces the notice; an explicit clear representation removes it. The request accepts at most 500 characters after trimming, and rejects empty strings, whitespace-only strings, overlong content, unknown fields, and settings requests with no actual update.

The commissioner edits the notice in Pool settings with a labelled textarea. The UI offers a save action and, only when a notice exists, a separate clear action. It uses the existing frozen-command/idempotency behavior, disables controls while pending, presents failures in the current accessible error summary, and refreshes the authoritative pool view after a successful mutation.

## Presentation and accessibility

The Layout renders the banner between the masthead and the primary navigation only when the authorized pool view contains a notice. It is a labelled semantic region with visible `Commissioner notice` text, uses a high-contrast notice color, and does not depend on color alone to communicate meaning. It is not an assertive live region, avoiding repeated screen-reader interruptions on ordinary route transitions. Text wraps safely on narrow viewports without causing horizontal overflow or reducing existing navigation target sizes.

## Verification

Tests will first cover exact HTTP/command/view contracts and PoolDO authorization, idempotency, replacement, and clear semantics. Web tests will cover member visibility, commissioner-only editing, accessible banner markup, and pending/error states. E2E tests will prove joined-route visibility and persistence, absence on the pool-entry route, forged-member rejection, replacement, and clear behavior. Existing privacy, navigation-cache, and responsive-accessibility contracts remain unchanged.
