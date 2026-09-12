# Activity Group by Day Design

## Goal

Keep Activity's existing per-member view as the default and add an off-by-default **Group by day** view. The selected week still scopes the data. Desktop shows independent Group by day and Active games only checkboxes; compact viewports use a native **Options** disclosure containing those same independent checkbox controls.

## Presentation and data flow

`activity-presentation.ts` derives safe, client-only day groups from the existing `ReadActivity` projection. Every visible ticket is assigned once:

- a ticket with an earliest visible losing leg goes on that leg's local kickoff day;
- otherwise, a ticket with one or more started visible legs goes on its most recently started leg's local kickoff day;
- a ticket with no visible started leg (including redacted tickets) goes in the single **Upcoming** group.

This keeps a live multi-leg ticket out of a future table and keeps a losing parlay or teaser with the day on which it first lost. A group has a table per day, a day heading using `Intl`'s short weekday form (`Thu`, `Fri`, etc.), and one in-table member ribbon before each member's rows. The ribbon links the name on the left and shows that member's aggregate day P&L on the right.

The page derives day/member P&L before applying Active games only, then filters ticket rows while retaining those pre-filter P&L values. This matches the existing weekly-ribbon invariant. Grouped mobile rows receive their table day as the date anchor so legs occurring on another day use the existing short weekday annotations.

## Privacy and residual

The implementation only reads the safe Activity projection. A completely hidden ticket is never inspected for teams, legs, or dates and is presented only in Upcoming. The HTTP contract has leg grades but no per-leg settlement timestamp; the earliest losing leg's kickoff date is therefore the best available loss-day evidence. No backend/API expansion is included.

## Verification

Focused Vitest coverage exercises assignment, loss/live/upcoming rules, P&L preservation before filtering, grouped markup, and desktop/mobile control variants. Run focused non-E2E tests, typecheck, build, and whitespace validation; leave the full suite and E2E to CI.
