# Shared Local Dev State Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make `npm run dev` use one stable, local D1/Durable Object state across the main checkout and every linked worktree.

**Architecture:** Resolve Git's common directory at runtime and use its parent checkout's existing `.dev.vars` and `.wrangler/state` as canonical local configuration and state. Inside the root-owned `.wrangler/dev-server.lock`, a linked worktree preserves any local `.dev.vars` in ignored canonical `.wrangler/dev-vars-backups/` and replaces it with a symlink to the canonical file; Vite therefore retains the invoking worktree's Worker config/namespace while loading shared secrets. Vite persistence and the D1 migration command receive the same state root. A kernel-held Linux `flock` is inherited by Vite through `exec`, avoiding concurrent SQLite/DO access and automatically releasing when the actual server exits. Shared state is only for branches compatible in both storage schema and Wrangler resource identity; it does not make historical branches safe to run after a newer schema is used.

**Tech Stack:** TypeScript, Node.js filesystem/process APIs, Vite, `@cloudflare/vite-plugin`, Wrangler local persistence, Vitest.

---

### Task 1: Specify shared-state resolution

**Files:**
- Create: `scripts/dev-state.ts`
- Modify: `tests/dev-config.test.ts`

**Step 1: Write the failing tests**

Add tests that specify:
- a root checkout and a linked worktree both resolve to the same root-owned lock, secret-backup directory, and `<common-git-parent>/.wrangler/state`.

**Step 2: Run the focused test to verify it fails**

Run: `npm test -- --maxWorkers=1 tests/dev-config.test.ts`

Expected: FAIL because the state-resolution and lock APIs do not exist.

**Step 3: Write the minimal implementation**

Implement small, reusable helpers that derive canonical root/state/lock/backup paths from `git rev-parse --git-common-dir`, safely link and preserve local secrets under the lock, validate required local secrets against the invoking worktree config, and fail clearly off Linux.

**Step 4: Run the focused test to verify it passes**

Run: `npm test -- --maxWorkers=1 tests/dev-config.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/dev-state.ts tests/dev-config.test.ts
git commit -m "feat: share local dev state across worktrees"
```

### Task 2: Make the normal dev command use the canonical state

**Files:**
- Create: `scripts/dev.ts`
- Modify: `vite.config.ts`
- Modify: `package.json`
- Modify: `tests/dev-config.test.ts`
- Modify: `README.md`
- Modify: `docs/operations.md`

**Step 1: Write the failing tests**

Add tests that specify:
- serving config supplies the shared state root through Vite's `persistState` option, while production builds do not;
- `npm run dev` invokes the launcher rather than a worktree-local `predev` migration command;
- the launcher applies migrations using `--persist-to` before it starts Vite.

**Step 2: Run the focused test to verify it fails**

Run: `npm test -- --maxWorkers=1 tests/dev-config.test.ts`

Expected: FAIL because the current configuration uses each worktree's default `.wrangler/state`.

**Step 3: Write the minimal implementation**

Create a `tsx` launcher that invokes `flock --no-fork` on a root-owned lock around a POSIX runner. Under that lock, the runner links and validates canonical local secrets, applies local D1 migrations with `--persist-to <canonical-state-root>`, and `exec`s Vite, so Vite itself retains the advisory lock until it exits. Forward every direct launcher signal to the detached lock-owning process group. Configure the Cloudflare Vite plugin with `persistState: { path: <canonical-state-root> }` only for supported launcher-backed `serve` commands; retain each worktree's config path so its Durable Object namespace remains stable.

**Step 4: Update operator documentation**

Document that the canonical root checkout's ignored `.wrangler/state` is the shared dev database; data survives branch switches and server restarts, but only one `npm run dev` process may use it at a time. State that E2E and smoke fixtures retain their explicit isolated persistence directories.

**Step 5: Run focused checks**

Run:
```bash
npm test -- --maxWorkers=1 tests/dev-config.test.ts
npm run typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add scripts/dev.ts vite.config.ts package.json tests/dev-config.test.ts README.md docs/operations.md
git commit -m "feat: persist dev state across branches"
```

### Task 3: Validate the active dev server against the existing state

**Files:**
- No source changes expected.

**Step 1: Restart the active branch server**

Stop the existing local server, then run the new `npm run dev` launcher on port 5178.

**Step 2: Verify it uses the canonical state and serves health**

Run:
```bash
curl -fsS http://127.0.0.1:5178/health/app
```

Expected: `{"status":"ok"}`. Confirm the launcher log identifies the canonical root state and that no new worktree-local state is selected.

**Step 3: Run the affected suite**

Run:
```bash
npm test -- --maxWorkers=1 tests/dev-config.test.ts
```

Expected: PASS.

**Step 4: Commit any intentional validation/doc adjustment**

```bash
git status --short
git add <intentional-files>
git commit -m "docs: clarify shared dev database" # only if needed
```
