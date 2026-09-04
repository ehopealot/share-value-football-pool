# NCAA Short Team Names Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Display concise NCAA football school names—such as `Texas` instead of `Texas Longhorns`—on the Odds Board, Activity, and My Bets pages without changing provider or persisted team identities.

**Architecture:** Add a frontend-only exact-name map derived from the development Odds API’s current NCAA feed. A helper returns the mapped school name only for `ncaaf`; unknown teams and every other league retain the original provider name. Apply it at all requested presentation points, while retaining raw names in offers, snapshots, canonicalization, placement, and settlement.

**Tech Stack:** TypeScript, React, Vitest, Playwright.

---

### Task 1: Add and test the display-only NCAA team-name mapping

**Files:**
- Create: `src/web/team-display.ts`
- Create: `tests/web-team-display.test.ts`

**Step 1: Write the failing test**

```ts
expect(displayTeamName("ncaaf", "Texas Longhorns")).toBe("Texas");
expect(displayTeamName("ncaaf", "Miami (OH) RedHawks")).toBe("Miami (OH)");
expect(displayTeamName("ncaaf", "Unknown Team")).toBe("Unknown Team");
expect(displayTeamName("nfl", "Kansas City Chiefs")).toBe("Kansas City Chiefs");
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --project=node tests/web-team-display.test.ts`
Expected: FAIL because the helper does not exist.

**Step 3: Write minimal implementation**

Add an exact `Record<string, string>` for the provider’s currently returned NCAA names and export `displayTeamName(league, name)`. Do not mutate raw event, offer, or wager data.

**Step 4: Run test to verify it passes**

Run: `npx vitest run --project=node tests/web-team-display.test.ts`
Expected: PASS.

### Task 2: Apply concise names to the requested UI surfaces

**Files:**
- Modify: `src/web/pages/OddsPage.tsx`
- Modify: `src/web/activity-presentation.ts`
- Modify: `tests/web-odds-display.test.ts`
- Modify: `tests/web-activity-presentation.test.ts`

**Step 1: Write failing presentation tests**

Cover an NCAA Activity/My Bets leg and an Odds Board game/pick label using `Texas Longhorns` and `Oklahoma Sooners`, asserting `Texas` and `Oklahoma` render. Cover NFL unchanged.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=node tests/web-team-display.test.ts tests/web-activity-presentation.test.ts tests/web-odds-display.test.ts`
Expected: FAIL because the pages still render raw provider names.

**Step 3: Write minimal implementation**

Carry `league` through the Odds Board game presentation and call the helper for team/outcome labels. Call the helper in activity leg formatting, which is shared by Activity and My Bets. Keep raw names for matching, quote construction, confirmation snapshots, and API payloads.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run --project=node tests/web-team-display.test.ts tests/web-activity-presentation.test.ts tests/web-odds-display.test.ts`
Expected: PASS.

### Task 3: Update and verify end-to-end coverage

**Files:**
- Modify: relevant NCAA fixture and display expectations under `e2e/` only if an existing fixture exercises raw NCAA names.

**Step 1: Check existing NCAA UI coverage**

Search: `rg -n 'ncaaf|Texas Longhorns' e2e tests`

**Step 2: Add or update one browser-level assertion if an existing local NCAA fixture supports it**

Assert the concise display name and absence of the mascot on the appropriate requested surface.

**Step 3: Verify**

Run targeted node tests, `npm run typecheck`, and `npm run build`. Do not run E2E locally unless CI fails, per `AGENTS.md`.
