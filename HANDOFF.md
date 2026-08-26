# Share Value Football Pool — Pause Handoff

- **Paused:** 2026-08-26
- **Repository:** <https://github.com/ehopealot/share-value-football-pool> (private)
- **Branch:** `feat/share-value-pool`
**Preservation commit:** `26be894` (`WIP: preserve Share Value pool implementation`)

## Current state

This is intentionally a **work in progress**, not a merge-ready or deployable release.

Development stopped during T11 review round R17. The R17 worker was interrupted before it edited any source or test file; it only began creating a uniquely owned temporary test harness under `/tmp`. Therefore, commit `26be894` contains the R16 implementation and the four unresolved findings below, not a partial R17 source fix.

No Pull Request or deployment was created. No production resources or secrets were configured.

## Last completed verification milestone

The R16 recovery verifier passed against the implementation immediately before R17:

- Worker/D1/PoolDO/Queue: 160 passing executions
- Explicit Node suite: 91/91
- Exact T11 Playwright: 12/12
- Exact T10 Playwright: 11/11
- Same-game export Playwright: 1/1
- Settlement/provenance pair: 22/22 twice
- Typecheck, builds, migrations/reapply, artifact graph, route probes, direction contract, Wrangler parity, cleanup, staged-state, and preview-preservation checks passed

Local recovery evidence was written to:

- `/tmp/share-value-pool-t11-r16-recovery-final-20260826T035824Z`
- `/tmp/share-value-pool-t11-r16-recovery-result.T11-r16-recovery-final-verify.json`
- `/tmp/share-value-pool-t11-r16-recovery-result.T11-r16-recovery-review.json`
- `/tmp/share-value-pool-t11-r16-recovery-result.T11-r16-recovery-final-assess.json`

Those `/tmp` artifacts are machine-local and are not part of the repository.

After R17 was interrupted, `npm run typecheck` passed before the WIP commit. Three trailing-whitespace-only corrections were then made while preparing the commit. A complete post-R17 suite was not run, so do not represent T11 as converged.

## T11 blockers to implement in R17

The fresh R16 reviewer and independent assessor both returned `REVISE`, `BLOCK`, and `nextTaskMayStart: false`. All four findings were source-confirmed and require no product approval.

### 1. P1 — Preserve immutable event side identity

Relevant files:

- `src/odds/the-odds-api-provider.ts`
- `src/odds/ingestion.ts`
- `src/durable/settlement.ts`
- `tests/odds/ingestion.test.ts`

Required behavior:

- Reject same-ID odds and score responses whose ordered home/away identities disagree.
- Reject a later same-ID provider event whose ordered sides differ from the persisted `sports_event`.
- Do not reinterpret immutable accepted wager selections during settlement.
- Add forward/reverse odds+score and later score-only swapped-side regressions proving provider-error health, byte-identical last-good event/offer/availability state, and no PoolDO settlement/account/wager/ledger/outbox/audit mutation.

### 2. P1 — Reject malformed provider numbers

Relevant files:

- `src/contracts/provider.ts`
- `src/odds/the-odds-api-provider.ts`
- `src/odds/market-semantics.ts`
- `tests/odds/ingestion.test.ts`

Required behavior:

- Parse score strings only as canonical nonnegative safe decimal integers.
- Reject empty or whitespace strings, signs, negatives, decimals, exponents, noncanonical leading zeros, and unsafe values.
- Require American prices to be safe, nonzero integers at both external and normalized trust boundaries.
- Add adapter-through-ingestion malformed-score and unsafe-price regressions proving provider-error health, byte-identical last-good state, and no settlement mutation.

### 3. P2 — Correct the deterministic placement snapshot proof

Relevant file:

- `tests/worker/deterministic-reader-snapshot.test.ts`

Required behavior:

- Boundary `after`: the reader already captured the complete old D1 snapshot, so placement must succeed with exactly the old immutable terms. Assert the expected command/version, processed-command, account, wager, leg/snapshot, ledger, outbox, alarm, audit, and reconciliation mutations.
- Boundary `before`: the new poll commits before the read, so placement must return `LINE_CHANGED` with the complete replacement and produce exhaustive byte-for-byte zero durable mutation.
- Do not change production snapshot semantics merely to make the test green.

### 4. P2 — Add the missing pre-claim failure barrier

Relevant file:

- `tests/odds/ingestion.test.ts`

Required behavior:

- Pause invocation A before generation claim.
- Let intervening claimant B fail and verify B's authoritative failure health.
- Resume A and prove claim-derived timestamp flooring, retained last-success availability, recomputed due leagues, final authoritative health, and generation-fenced writes.
- Preserve the existing intervening-success and provider-I/O overlap cases.

## How to resume

1. Check out `feat/share-value-pool` and run `npm ci`.
2. Read this handoff, `PRODUCT.md`, the approved design/plan, and `.superpowers/sdd/2026-08-22-share-value-football-pool/task-11-brief.md`.
3. Apply the four R17 findings one at a time with strict RED → observed failure → minimal GREEN TDD.
4. Use a uniquely owned temporary Cloudflare/Vitest/Vite/Playwright harness. Repository-root Cloudflare tooling may discover local `.dev.vars`; do not accept such runs as evidence. Use `--env-file /dev/null` where supported and never inspect secret contents.
5. Rerun the complete R16 recovery gate with realistic Worker timeouts, including the settlement pair twice and exact whole-file T10/T11 browser runs.
6. Run a fresh adversarial whole-T11 review and independent assessment. Start T16 only when both return `CONVERGED` with `nextTaskMayStart: true`.

After T11, the intended sequence was:

`T16 → T12 → T20 → Resend EmailSender production adapter → decay review → final whole-branch review → PR`

## Security and deployment notes

- `.dev.vars` is ignored and was not committed or pushed.
- `.dev.vars.example` contains local-only example values.
- Do not run the finish detector until the planned T12 one-shot finish phase.
- Before any deployment, make artifact verification fail closed on `.dev.vars` and other secret-suffix output without reading secret contents.
- Production Resend wiring, verified sender/domain, Workers secrets, and verification/reset URL configuration remain unimplemented.
- Confirm production observability cannot log Better Auth verification/reset tokens before deployment.
- No deployment, production resource creation, or secret configuration has occurred.

## Local-only residue

The following were deliberately excluded from the WIP commit:

- generated `dist-local/`
- `docs/superpowers/specs/.#2026-08-23-t10-structural-convergence-design.md` editor lock
- ignored local `.dev.vars`

The existing local preview process was not stopped or modified while preserving the branch.
