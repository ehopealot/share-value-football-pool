# Blue Push Grades Design

## Decision

Render a settled `push` leg in blue across both Activity and My Bets. The entire leg line receives the blue color, matching the current whole-line green win and red loss treatment. Open, pending, and void legs remain neutral.

## Implementation

Add one shared Activity presentation helper that maps a leg grade to its display class: `win` to `activity-leg-win`, `loss` to `activity-leg-loss`, `push` to `activity-leg-push`, and all other states to `activity-leg-neutral`. Both page-specific `WagerLine` components call that helper instead of maintaining duplicate grade conditionals. Define the new class with a readable blue in the existing wager-grade style group.

## Verification

Add rendering assertions that a push leg emits `activity-leg-push` in Activity and My Bets, plus a style assertion that the class is blue. Run the focused web tests, then the non-e2e CI-equivalent test suite and typecheck.
