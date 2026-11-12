# Multi-stake details implementation plan

**Goal:** Make the stake/odds display for parlays and teasers open leg details everywhere a Staked column appears.

**Architecture:** Replace duplicated stake markup with `WagerStake`. Straight wagers remain plain text. Multi wagers open a compact native modal dialog, portaled outside scrollable tables, using only authorized legs already present in the read response. Share `WagerLine` formatting. Parlay legs show their recorded original odds explicitly labeled as source odds (not reconstructed ticket pricing). Teasers show original → adjusted lines and the signed difference. No API changes or extra data fetches.

**Tech stack:** React, TypeScript, native HTML dialog, existing CSS tokens, Vitest.

## Approved design

The user approved a small modal rather than a tooltip. Preserve the square, compact table-oriented visual language and existing share-number + odds layout. Use an underlined semantic button for multi stakes. Include a title, ticket stake/odds, leg list, and Close button. Native modal behavior supplies focus containment and Escape dismissal; restore focus to the trigger. Allow backdrop dismissal. Only visible legs can appear, with a neutral hidden-leg notice. Missing stakes preserve existing null/em-dash behavior. Unknown/missing teaser line values must not become zero or NaN.

## Implementation steps

1. Add `tests/web-wager-stake.test.ts` for multi triggers, unchanged straight stakes, authorized/hidden legs, original parlay odds, spread and over/under teaser adjustments, and missing lines. Run the focused test and observe missing feature failures.
2. Create `src/web/components/WagerStake.tsx` and scoped modal/button styles in `src/web/styles.css`. Use `useId` for duplicate ticket instances; mount dialog content only when opened and portal to document.body.
3. Replace stake renderers in `ActivityPage.tsx` (also covers live games and member profiles), `MyWagersPage.tsx`, and `MatchupDetailsPage.tsx`. Update existing source/markup assertions to the shared component. Correction summaries have no Staked column and remain unchanged.
4. Run focused web unit tests, TypeScript, and build. Inspect a standalone component browser fixture on desktop/mobile, including keyboard open/close, focus restoration, scrolling, and no overflow. Do not run the e2e suite.
5. Review the diff, commit, and open a PR against main. CI remains the full-suite gate; do not merge or deploy without green CI.

## Residuals

Source odds are immutable original per-leg snapshots, not house-adjusted parlay pricing; label them explicitly. The existing backend remains the authority for leg visibility and ticket-term redaction. Native dialog requires a modern browser, consistent with the app's Vite browser target.
