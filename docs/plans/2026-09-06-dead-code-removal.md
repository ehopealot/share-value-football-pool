# Dead Code Removal Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Remove all code approved in the personal dead-code audit of `5a71913`, including test-only implementations.

**Architecture:** Delete unreachable implementations and their dedicated tests, preserving live contracts, shared helpers, and side-effecting setup. Remove newly orphaned reference-model types as part of the same cleanup. No runtime behavior changes are intended.

**Tech Stack:** TypeScript, React, Zod, Cloudflare Workers, Vitest.

## 1. Remove implementations and their tests

- Delete `src/worker/schemas.ts`, `src/domain/ledger.ts`, and the ledger model's dedicated tests/types if orphaned.
- Remove unused aliases from `src/contracts/http.ts`, `FixedClock` from `src/platform/clock.ts`, and the placeholder from `src/web/pages/StatePage.tsx`.
- Remove the approved test-only helpers in activity presentation, selection tray, OddsPage, email sender, offer quotes, command contracts, and pool registry.
- Remove tests dedicated to these helpers. Preserve assertions against live ingestion, durable accounting, HTTP contracts, and notifications in mixed tests.
- Remove the three unused Activity CSS selectors and overridden tray declarations.
- Remove all audited unused imports/locals/parameters, preserving awaited request side effects.

## 2. Validate and personally review

The audit's strict unused-binding checks already fail on the approved unused bindings (red baseline).

- Run TypeScript with `--noUnusedLocals --noUnusedParameters --noEmit --incremental false` for the main and E2E projects; expect success after removal.
- Search for dangling references and inspect the full diff for unintended behavior changes.
- Run focused non-E2E Vitest suites where feasible. Leave full-suite validation to CI; do not run E2E locally.
- Confirm `git diff --check` is clean.

## 3. Deliver

Commit on `chore/dead-code-audit`, push, and open a pull request with the removals and validation evidence. Do not merge or deploy; a green CI build is required.

## Execution evidence

- Removed all approved implementations, the now-orphaned reference `season.ts` types, the placeholder's ignored `Layout.signedIn` prop, and the unused `fast-check` dependency (including its lockfile-only dependency).
- Kept live notification and parlay validation coverage by exercising the production entry points. Mixed ingestion tests now inspect persisted offers directly where appropriate; live durable accounting tests remain.
- Main and E2E TypeScript projects passed with `--noUnusedLocals --noUnusedParameters --noEmit --incremental false`.
- Focused Node validation: 15 files, 102 tests passed (auth, contracts, affected web tests, package pins, accessibility, wager colors, message-board layout, commissioner notice).
- Focused Worker validation: 8 files, 153 tests passed (orders, privacy/outbox, wager settlement, ingestion, HTTP API, creation saga, entry surface, registry).
- Personally reviewed the complete diff and verified no remaining executable references to the removed implementations. `git diff --check` passed.
- No local E2E tests were executed. Full CI remains the merge gate.
