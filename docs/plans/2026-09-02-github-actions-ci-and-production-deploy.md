# GitHub Actions CI and Production Deploy Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Run repository CI for pull requests and deploy the Cloudflare Worker automatically after a green push to `main`.

**Architecture:** A single GitHub Actions workflow has a CI job shared by pull requests and `main` pushes. A dependent, serialized deploy job runs only after the CI job succeeds on `main`; it applies remote D1 migrations, uses the existing guarded production deployment script, and checks the public health endpoint. The deployment script preserves a scoped Cloudflare API token only in CI while retaining its local OAuth-only safety behavior.

**Tech Stack:** GitHub Actions, Node 24, Vitest, TypeScript, Wrangler 4, Cloudflare Workers and D1.

---

### Task 1: Make the guarded deploy script CI-token aware

**Files:**
- Modify: `scripts/deploy-production.mjs`
- Modify: `tests/production-deploy.test.ts`

**Step 1: Write the failing tests**

Add one test confirming local deployment removes `CLOUDFLARE_API_TOKEN` and all legacy API credential variables, and a second test confirming `CI=true` preserves only `CLOUDFLARE_API_TOKEN` for Wrangler while still removing global-key and email credential variables.

**Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/production-deploy.test.ts`

Expected: FAIL because the current helper removes the scoped CI token unconditionally.

**Step 3: Implement the minimal deployment-environment change**

Replace the OAuth-only environment helper with one that always removes global API-key/email credentials, removes API-token variables for local runs, and preserves only `CLOUDFLARE_API_TOKEN` when `CI` is exactly `"true"`.

**Step 4: Run the focused test to verify it passes**

Run: `npm test -- tests/production-deploy.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/deploy-production.mjs tests/production-deploy.test.ts
git commit -m "Support token-authenticated CI deployments"
```

### Task 2: Add the CI and deployment workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `tests/github-actions-workflow.test.ts`
- Modify: `docs/production-deployment.md`

**Step 1: Write the failing workflow-contract test**

Create a test that reads `.github/workflows/ci.yml` and requires: pull-request and `main` push triggers; a Node 24 CI job that runs `npm ci`, the full Vitest suite with `--maxWorkers=5`, typecheck, and `git diff --check`; and a dependent deploy job restricted to `push` events on `main` with non-cancelling production concurrency, token/public-key environment inputs, D1 migration, guarded deploy, and a `/health/app` HTTP-200 check.

**Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/github-actions-workflow.test.ts`

Expected: FAIL because no workflow exists.

**Step 3: Implement the workflow and operator documentation**

Create the workflow with `actions/checkout@v4` and `actions/setup-node@v4`, repository permissions limited to `contents: read`, and no deployment job for pull requests. Document these GitHub settings:

- Repository secret: `CLOUDFLARE_API_TOKEN`
- Repository variable: `VITE_TURNSTILE_SITE_KEY`

Do not move Worker runtime secrets from Cloudflare to GitHub.

**Step 4: Run the focused workflow-contract test to verify it passes**

Run: `npm test -- tests/github-actions-workflow.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml tests/github-actions-workflow.test.ts docs/production-deployment.md
git commit -m "Add CI-gated production deployment workflow"
```

### Task 3: Verify the combined change

**Files:**
- Verify only

**Step 1: Run repository verification**

Run:

```bash
npm test -- --maxWorkers=5
npm run typecheck
git diff --check
```

Expected: all commands exit successfully.

**Step 2: Inspect the staged diff**

Run:

```bash
git diff --cached --check
git diff --cached --stat
```

Expected: only CI workflow, guarded deployment, documentation, and tests are staged.

**Step 3: Merge and deploy behavior**

After the change is reviewed and merged to `main`, GitHub Actions runs CI and deploys only when the CI job succeeds. Before enabling the workflow, configure the named GitHub secret and variable; the first merge provides the live validation.
