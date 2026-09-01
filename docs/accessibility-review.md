# Accessibility and responsive review

## Scope

T16 adds a deterministic Playwright matrix in `e2e/responsive-a11y.spec.ts` for signed-out routes, authenticated primary routes, a closed-signup state, keyboard focus, error presentation, table semantics, 390px reflow, 200% zoom reflow, reduced motion, and axe checks. The local pool helper creates real accounts, sessions, pools, and seasons against isolated Wrangler emulation.

## Automated evidence

- `tests/accessibility/contrast.test.ts` verifies AA contrast for text, navigation, links, actions, and error summaries.
- `tests/accessibility/focus-contrast.test.ts` verifies visible focus coverage, including selects and the dark ribbon control.
- `tests/accessibility/touch-target.test.ts` verifies 44px minimum ribbon/action targets at the 600px mobile breakpoint.
- `e2e/responsive-a11y.spec.ts` is the browser/axe route-state matrix.

## Findings and fixes

- Added column headers to the Games odds table so assistive technology can associate the three market columns with their controls.
- Added visible focus styling to selects.
- Added mobile 44px targets for ribbon links and action controls.
- Preserved horizontal table overflow inside table containers rather than the document viewport.

## Browser evidence

The complete `e2e/responsive-a11y.spec.ts` matrix passes against isolated local Wrangler emulation with axe enabled. During the review it found and drove fixes for missing Games/Share Orders table headers, a missing closed-pool page heading, a narrow bet-slip reflow overflow, unfocusable scroll containers, and unwrapped wide member/commissioner tables. The suite exercises 390px and 320px effective reflow, reduced motion, visible keyboard focus, error messaging, authenticated and signed-out routes, and the closed-signup state.

## Finish detector review

The one permitted detector run recorded `overused-font` for Arial. This is an intentional exception: the approved visual direction explicitly uses Arial/Verdana as workhorse typefaces for the compact 2007-era operating surface. No font substitution was made, because changing it would contradict the product’s documented visual direction without improving usability or accessibility.
