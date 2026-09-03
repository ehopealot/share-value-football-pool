# Parlays and Six-Leg Wager Cap Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add versioned, immutable pre-game parlays with a six-leg maximum and reduce new teaser tickets to a six-leg maximum without breaking legacy accepted seven-leg teaser replay or settlement.

**Architecture:** Add a pure `PARLAY_2026_V1` pricing/validation module shared by the Worker quote boundary, PoolDO placement boundary, and settlement. Introduce a dedicated parlay quote/place command path and a lean TeaserPage-style ParlayPage; preserve seven-leg teaser envelopes only long enough to replay prior durable commands, while all fresh quote/placement paths reject them after replay misses.

**Tech Stack:** TypeScript, Zod, React/Vite, Hono, Cloudflare Workers, Durable Objects SQLite, Vitest, Cloudflare Vitest pool.

---

## Review protocol

After each implementation task, run the task's targeted tests, commit it, then obtain an independent expert code review. Resolve every material finding and request re-review before starting the next task. The existing architecture review is approved after revision; final whole-branch code/architecture reviews must converge before a PR is opened.

Do not run Playwright locally unless a related CI failure requires it. Keep a single writer in this worktree.

### Task 1: Add exact, versioned parlay domain rules

**Files:**
- Create: `src/domain/parlay.ts`
- Create: `tests/domain/parlay.test.ts`
- Modify: `src/contracts/commands.ts` (safe American-price boundary only, if needed by the domain type)

**Step 1: Write the failing domain tests**

Define a small leg fixture with `eventId`, `market`, `selection`, and `originalOdds`. Test the desired public API:

```ts
expect(parlayOdds([
  leg("one", "spread", "home", -110),
  leg("one", "total", "over", -110)
])).toBe(250);

expect(parlayOdds([
  leg("one", "moneyline", "home", -150),
  leg("two", "total", "over", -110)
])).toBe(233);
```

Also cover `PARLAY_2026_V1`, 2–6 legs, exact duplicate/opposing-market rejection, spread-plus-moneyline rejection for one event, safe `+/-100` boundary conversion, negative final odds, too-large output rejection, loss precedence, broken same-game-pair repricing, one surviving leg, and all-push/void refund.

**Step 2: Verify RED**

Run:

```bash
npx vitest run --project=node tests/domain/parlay.test.ts
```

Expected: FAIL because `src/domain/parlay.ts` and its exports do not exist.

**Step 3: Implement the smallest pure module**

Create `src/domain/parlay.ts` with:

- `PARLAY_RULESET_ID = "PARLAY_2026_V1"`;
- `validateParlay(legs)` for the semantic 2–6, per-event, duplicate, and market-selection rules;
- reduced `BigInt` fraction multiplication for all leg prices;
- total leg substitution to `-133` only when the same event contains a spread or moneyline;
- canonical conservative rational-to-American conversion: `+floor(100*(N-D)/D)` for `N >= 2D`, otherwise `-ceil(100*D/(N-D))`, exact `2D` as `+100`;
- safe nonzero-integer input/output checks and `PARLAY_ODDS_OUT_OF_RANGE`;
- `gradeParlay(grades, legs)` that returns `loss`, `refund`, or `win` plus effective odds after removing pushes/voids.

Use `BigInt` throughout until the final safe `number` conversion. Do not use `Math` for payout arithmetic.

**Step 4: Verify GREEN**

Run the same targeted command. Expected: all new domain tests pass.

**Step 5: Commit**

```bash
git add src/domain/parlay.ts tests/domain/parlay.test.ts src/contracts/commands.ts
git commit -m "feat: add exact parlay pricing rules"
```

**Step 6: Review gate**

Request an `expert-code-reviewer` review of this commit, focused on rational arithmetic, conservative rounding, and selection semantics. Fix/retest/re-review material findings.

### Task 2: Extend parlay contracts and browser boundary

**Files:**
- Modify: `src/contracts/commands.ts`
- Modify: `src/contracts/http.ts`
- Modify: `src/web/api.ts`
- Modify: `tests/web-api.test.ts`
- Create: `tests/contracts/parlay-contracts.test.ts`

**Step 1: Write failing contract/browser-boundary tests**

Add tests for `QuoteParlayWager` / `PlaceParlayWager` semantic requests, immutable quote snapshots, and the browser quote parser/placement builder. Require 2–6 legs, safe nonzero American prices, `PARLAY_2026_V1`, and complete immutable legs. Keep the legacy teaser envelope schemas demonstrably able to parse seven legs; fresh-limit enforcement belongs to the replay-aware Worker/PoolDO task.

**Step 2: Verify RED**

Run:

```bash
npx vitest run --project=node tests/contracts/parlay-contracts.test.ts tests/web-api.test.ts
```

Expected: FAIL because parlay schemas, snapshot parsing, and placement builder are absent.

**Step 3: Add contract-only parlay vocabulary**

In `commands.ts`, define complete parlay-leg, semantic request-leg, quote snapshot/projection, and placement schemas. Reuse canonical leg proof rules: non-moneyline proof odds equal the strike; moneyline proof records bookmaker odds while `originalOdds` retains the server-derived strike. Make all American odds safe nonzero integers.

Keep teaser array envelope schemas at `.max(7)` for durable compatibility. Do not add fresh-cap behavior here because HTTP and PoolDO must first have an opportunity to recover exact historical bytes.

In `http.ts`, add quote/place schemas and aliases for parlays. In `web/api.ts`, add the quote parser, placement builder, and client method; endpoint registration waits for Task 3. Extend member wager type later in Task 4.

**Step 4: Verify GREEN and typecheck**

Run:

```bash
npx vitest run --project=node tests/contracts/parlay-contracts.test.ts tests/web-api.test.ts
npm run typecheck
```

Expected: all contract/browser-boundary tests and typecheck pass without requiring a real Durable Object parlay endpoint.

**Step 5: Commit and review**

```bash
git add src/contracts/commands.ts src/contracts/http.ts src/web/api.ts tests/contracts/parlay-contracts.test.ts tests/web-api.test.ts
git commit -m "feat: define parlay quote contracts"
```

Request an `expert-code-reviewer` review focused on safe schema boundaries, moneyline proof/strike distinction, and preserving legacy teaser envelopes. Fix/retest/re-review findings.

### Task 3: Migrate PoolDO storage and implement authoritative placement/settlement

**Files:**
- Modify: `src/contracts/commands.ts`
- Modify: `src/durable/schema.ts`
- Modify: `src/durable/pool-commands.ts`
- Modify: `src/durable/pool-do.ts`
- Modify: `src/durable/wager-commands.ts`
- Modify: `src/durable/settlement.ts`
- Modify: `src/worker/offer-quotes.ts`
- Modify: `src/worker/routes.ts`
- Modify: `src/worker/do-router.ts`
- Modify: `src/web/api.ts`
- Modify: `tests/durable/pool-authority.test.ts`
- Modify: `tests/durable/wagers-settlement.test.ts`
- Modify: `tests/durable/privacy-outbox.test.ts`
- Modify: `tests/worker/entry-surface.test.ts`
- Modify: `tests/worker/api.test.ts`

**Step 1: Write failing end-to-end Worker/PoolDO tests**

Recreate populated legacy `wager` and `settlement` tables without the new variants, with straight/teaser rows (including a historical seven-leg teaser and noncontiguous wager rowids), dependent legs, settlements, quotes, and processed commands. Exercise PoolDO constructor startup twice and test that migration:

- preserves all rows and their `rowid` ordering on first and second pass;
- adds nullable `settled_odds` without changing historical rows;
- leaves dependent data intact;
- admits a valid `parlay` after rebuilding the legacy table while still rejecting an unknown type and invalid status.

Add real HTTP quote/place tests after migration proving a parlay locks shares, snapshots legs, stores type/ruleset/price, applies shared side exposure, rejects malformed or forged placements without mutation, replays exactly, settles `+250`, reprices after a push, persists effective `settledOdds`, refunds all-push tickets, and regrades from immutable terms. Include real moneyline proof-vs-vig-free-strike placement coverage. Assert a committed `PlaceParlayWager` outbox row parses and drains successfully with only pool/actor/command/season/member/wager identities—never legs, terms, or financial values.

Seed a seven-leg legacy `wager_quote` and a successful seven-leg `processed_command`; after successful D1 registry resolution, make mutable market-offer access unavailable and require byte-equivalent quote/placement replay responses and no new mutation or offer query. With fresh keys, require the same envelopes to fail after replay miss. Add a six-safe-leg overflow quote fixture that returns `PARLAY_ODDS_OUT_OF_RANGE` and leaves no durable quote, processed command, account, or ledger mutation.

**Step 2: Verify RED**

Run:

```bash
npx vitest run --project=workers tests/durable/pool-authority.test.ts tests/durable/wagers-settlement.test.ts tests/durable/privacy-outbox.test.ts tests/worker/entry-surface.test.ts tests/worker/api.test.ts
npm run typecheck
```

Expected: FAIL because the schema, command dispatch, and settlement behavior do not yet support parlays/effective odds.

**Step 3: Implement atomic schema evolution**

Update the new-database `wager` CHECK to include `parlay` and `settlement` to include nullable `settled_odds`. In the startup migrator, execute the existing schema upgrades inside `state.storage.transactionSync`. Detect the old wager DDL through `sqlite_master`; if its CHECK lacks `parlay`, create a replacement table with the full current definition, copy all explicit columns and `rowid` in deterministic order, then drop/rename atomically. Add `settled_odds` only when absent. Make the migration idempotent; never drop a table outside the transaction.

**Step 4: Implement the complete authoritative pipeline**

Extend the PoolDO command union, request fingerprinting, quote kind, replay probe, outbox, and `placementTerms` for `parlay`. Extend the `CommandApplied` contract with `PlaceParlayWager` using the same least-data identity as other wager placement events. Extend Worker canonicalization/revalidation to derive and verify `PARLAY_2026_V1`, then register `/wagers/parlays/quote` and `/wagers/parlays/place` with the same replay-first ordering as teasers.

Keep seven-leg teaser envelope parsing at the outer boundaries. D1 registry resolution from slug to PoolDO remains a deliberate prerequisite; normalize thrown registry lookup failures as retryable pool availability, without adding a durable directory, client-held pool identity, cache, or deterministic naming migration. After registry resolution, attempt `ReplayWagerQuote` or `ProbePlacementReplay` before PoolDO view work, mutable market-offer reads, or placement revalidation. After a replay miss, reject a fresh seven-leg quote/placement in both Worker and PoolDO before mutable canonicalization/placement. Exact stored legacy responses must return before those checks. The residual behavior is that a registry outage prevents replay until registry availability recovers.

In `placeWager`, centralize canonical-leg validation so moneyline proof odds may differ from the vig-free `originalOdds`; validate parlay ruleset and exact derived price before account mutation. Insert `parlay` and its normal unadjusted leg snapshots.

In settlement, retain all-final lifecycle eligibility, then dispatch by wager type and ruleset. A final losing leg plus a missing/pending leg remains open with risk locked; once all legs are final, pass full stored legs to `gradeParlay`, apply loss precedence, and write `settled_odds` for winning effective prices. Keep reversal accounting based on recorded return/profit; Task 4 exposes effective settlement terms at read/audit/UI boundaries.

**Step 5: Verify GREEN**

Re-run the command from Step 2. Expected: all migration, quote/replay, accounting, settlement, overflow, and regrade tests pass.

**Step 6: Commit and review**

```bash
git add src/contracts/commands.ts src/durable src/worker src/web/api.ts tests/durable tests/worker
git commit -m "feat: settle immutable parlay wagers"
```

Request an `expert-code-reviewer` review focused on migration atomicity/idempotence, exact legacy replay before D1 access, overflow zero-mutation handling, moneyline proof validation, settlement/reversal correctness, privacy, and no-mutation failures. Fix/retest/re-review material findings.

### Task 4: Add parlay read presentation and publish rules

**Files:**
- Modify: `src/contracts/http.ts`
- Modify: `src/durable/views.ts`
- Modify: `src/services/audit-export.ts`
- Modify: `src/web/components/Confirmation.tsx`
- Modify: `src/web/pages/MyWagersPage.tsx`
- Modify: `src/web/pages/RulesPage.tsx`
- Modify: `src/web/pages/AdminSettingsPage.tsx`
- Modify: `src/web/pages/AdminCorrectionsPage.tsx`
- Modify: `src/web/pages/HistoryPage.tsx`
- Modify: `src/web/components/WagerDetails.tsx`
- Modify: `tests/contracts/t11-read-contracts.test.ts`
- Modify: `tests/durable/t11-member-reads.test.ts`
- Modify: `tests/worker/exports.test.ts`
- Modify: `tests/worker/t11-admin-api.test.ts`
- Modify: `tests/web-rules-page.test.ts`
- Modify: `tests/web-wager-presentation.test.ts`
- Modify: `tests/web-history-page.test.ts`
- Modify: `tests/web-api.test.ts`

**Step 1: Write failing presentation tests**

Require read/audit serializers and schemas to emit/accept `type: "parlay"` and nullable `settledOdds`. Define and test display semantics: open tickets show their accepted odds; new winning settlements show the effective settled odds; losses, refunds, and historical `NULL` settled odds show no paid odds/“not recorded” rather than falsely presenting accepted odds as the payout price. Verify Rules publishes the six-leg cap, permitted markets, one-directional-market-per-event rule, `-133` same-game total adjustment, push/void repricing, and `PARLAY_2026_V1`. Verify the commissioner help text says multi-leg teaser and parlay risk is divided across original legs. Test a mixed archived teaser/parlay season so guidance links each wager to the matching rules without treating the season teaser ruleset as the parlay ruleset.

**Step 2: Verify RED**

Run:

```bash
npx vitest run --project=node tests/contracts/t11-read-contracts.test.ts tests/web-rules-page.test.ts tests/web-wager-presentation.test.ts tests/web-history-page.test.ts tests/web-api.test.ts
npx vitest run --project=workers tests/durable/t11-member-reads.test.ts tests/worker/exports.test.ts tests/worker/t11-admin-api.test.ts
```

Expected: FAIL on the unknown parlay type, missing settled odds, missing historical rule guidance, and missing published rules.

**Step 3: Implement transparent presentation**

Extend read/audit contract schemas and serializers in `views.ts` and `audit-export.ts`. Add a parlay `Confirmation` branch that lists quoted canonical legs, final authoritative odds/return, and a clear same-game-total adjustment note. Update My Wagers and WagerDetails to distinguish accepted ticket odds from recorded effective settlement odds; never substitute an accepted price for an absent historical effective price. Make HistoryPage render wager-level guidance for `PARLAY_2026_V1` alongside its season teaser guidance. Add a dedicated parlay section to Rules and accurate multi-leg exposure copy. Keep existing redaction/presentation functions generic unless a parlay-specific message is actually needed.

**Step 4: Verify GREEN**

Re-run the command from Step 2. Expected: all output contracts and compact table views pass.

**Step 5: Commit and review**

```bash
git add src/contracts/http.ts src/durable/views.ts src/services/audit-export.ts src/web tests/contracts tests/durable/t11-member-reads.test.ts tests/worker/exports.test.ts tests/worker/t11-admin-api.test.ts tests/web-*.test.ts
git commit -m "feat: present parlay terms and settlement odds"
```

Request an `expert-code-reviewer` review focused on audit truthfulness, historical terms, leg redaction, and accessible language. Fix/retest/re-review material findings.

### Task 5: Build the lean teaser-style Parlay page and cap teaser UI at six

**Files:**
- Create: `src/web/parlay-slip.ts`
- Create: `src/web/pages/ParlayPage.tsx`
- Modify: `src/web/router.tsx`
- Modify: `src/web/pages/OddsPage.tsx`
- Modify: `src/web/selection-tray.ts`
- Modify: `src/web/teaser-slip.ts`
- Modify: `src/web/pages/TeaserPage.tsx`
- Modify: `src/web/styles.css`
- Modify: `src/web/api.ts` only if Task 2 did not finish browser helpers
- Modify: `tests/web-entry.test.ts`
- Modify: `tests/web-selection-tray.test.ts`
- Create or modify: `tests/web-parlay-page.test.ts`

**Step 1: Write failing browser-unit tests**

Test a parlay slip accepts a valid 2–6 selection set, rejects a second spread/moneyline from one event, preserves a paired total, and transfers all selected legs or none. Test its recovery rebuilds selections only from the current board and does not trust replacement payloads. Test the Parlay page follows editing → quoting → review → submitting, sends a parlay quote/place payload, uses a frozen retry, and identifies advisory editor pricing versus authoritative review terms.

Change teaser tests to expect a sixth leg accepted and seventh rejected by both `addTeaserLeg` and editor validation, while legacy server settlement tests remain unchanged.

**Step 2: Verify RED**

Run:

```bash
npx vitest run --project=node tests/web-entry.test.ts tests/web-selection-tray.test.ts tests/web-parlay-page.test.ts
```

Expected: FAIL because the parlay slip/page/route and six-leg UI cap do not exist.

**Step 3: Implement the smallest UI flow**

Create a `parlay-slip` helper parallel to `teaser-slip`, using a distinct session key and all-or-nothing validation. Create `ParlayPage` by following TeaserPage's state machine but omit point radios and adjusted-line presentation. It has a selected-leg table, one whole-share risk input, advisory current-board estimate, review snapshot, confirmation, explicit stale recovery, and no batch-straight behavior.

Add `Build parlay` to OddsPage. It validates the complete selected tray before removing anything or navigating. Register `/p/:slug/parlay`. Update `teaser-slip` and TeaserPage wording/validation to 2–6; leave the server's legacy envelope behavior untouched. Reuse established CSS table, confirmation, focus, responsive scroll, and action classes; add only narrowly needed classes.

**Step 4: Verify GREEN**

Re-run the command from Step 2. Expected: parlay lifecycle, all-or-nothing transfer, stale recovery, accessibility labels, and teaser six-leg UI tests pass.

**Step 5: Commit and review**

```bash
git add src/web tests/web-entry.test.ts tests/web-selection-tray.test.ts tests/web-parlay-page.test.ts
git commit -m "feat: add parlay builder and six-leg teaser UI"
```

Request an `expert-code-reviewer` review focused on the teaser-like state machine, frozen retry/recovery, client/server authority boundary, keyboard accessibility, and scope restraint. Fix/retest/re-review material findings.

### Task 6: Verify the complete branch and prepare the pull request

**Files:**
- Modify only if review findings require changes.

**Step 1: Run the non-E2E verification suite**

```bash
npm test
npm run typecheck
npm run build
npm run verify:direction-contract
```

Do not run `npm run test:e2e` unless a related failure makes it necessary.

**Step 2: Inspect branch hygiene**

```bash
git status --short
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: no unstaged/generated files and a focused commit history.

**Step 3: Final expert convergence review**

Dispatch `expert-code-reviewer` and `expert-architecture-reviewer` as independent read-only whole-branch reviews against `origin/main...HEAD`, with the approved design as requirements. Address every material finding with a failing regression test, minimal fix, targeted verification, and re-review. Repeat until both reviewers report convergence/no unresolved material findings.

**Step 4: Final verification after the last review fix**

Re-run all commands in Step 1 plus the specific regressions added for review findings. Record commands and outcomes in the final PR description.

**Step 5: Create and push the pull request**

```bash
git push -u origin feat/parlays-six-leg-cap
gh pr create --base main --head feat/parlays-six-leg-cap --title "feat: add parlays and cap wagers at six legs" --body-file /tmp/parlay-pr-body.md
```

The PR body must summarize product rules, compatibility behavior for legacy seven-leg teaser tickets, verification commands, review convergence evidence, and any residual risks.
