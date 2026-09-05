import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(root, ".github/workflows/ci.yml");
const packageManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> };

const workflowSource = () => readFileSync(workflowPath, "utf8");
const jobSource = (workflow: string, job: string, nextJob?: string) => {
  const end = nextJob ? `(?=\\n  ${nextJob}:)` : "$";
  const match = workflow.match(new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)${end}`));
  expect(match, `${job} job must exist`).not.toBeNull();
  return match![1];
};
const sensitiveVariableName = String.raw`(?:CLOUDFLARE_[A-Z0-9_]*|[A-Z0-9_]*(?:SECRET|TOKEN|KEY)[A-Z0-9_]*)`;
const credentialReference = new RegExp(String.raw`\b(?:secrets\s*(?:\.\s*[A-Z0-9_]+|\[\s*["'][A-Z0-9_]+["']\s*\])|vars\s*(?:\.\s*${sensitiveVariableName}|\[\s*["']${sensitiveVariableName}["']\s*\]))`, "i");

describe("GitHub Actions CI and production deployment", () => {
  it("detects dot and bracket credential references", () => {
    for (const reference of [
      "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      "${{ secrets['CLOUDFLARE_API_TOKEN'] }}",
      "${{ vars.VITE_TURNSTILE_SITE_KEY }}",
      "${{ vars['VITE_TURNSTILE_SITE_KEY'] }}"
    ]) expect(reference).toMatch(credentialReference);
  });
  it("runs CI for pull requests and main pushes without deployment credentials", () => {
    const workflow = workflowSource();
    const ci = jobSource(workflow, "ci", "e2e");

    expect(workflow).toMatch(/\non:\n  pull_request:\n  push:\n    branches: \[main\]/);
    expect(ci).toMatch(/actions\/checkout@v4\n\s+with:\n\s+fetch-depth:\s*2/);
    expect(ci).toContain("actions/setup-node@v4");
    expect(ci).toMatch(/node-version:\s*["']?24["']?/);
    expect(ci).toContain("npm ci");
    expect(ci).toContain("npm test -- --maxWorkers=5");
    expect(ci).toContain("npm run typecheck");
    expect(ci).toContain("git rev-parse --verify HEAD^");
    expect(ci).toContain("git diff --check HEAD^ HEAD");
    expect(ci).not.toMatch(credentialReference);
  });

  it("runs the complete Playwright suite as an advisory pull-request check", () => {
    const workflow = workflowSource();
    const e2e = jobSource(workflow, "e2e", "deploy");
    const deploy = jobSource(workflow, "deploy");

    expect(e2e).toMatch(/if:\s*github\.event_name == ['"]pull_request['"]/);
    expect(e2e).toMatch(/continue-on-error:\s*true/);
    expect(e2e).toContain("actions/checkout@v4");
    expect(e2e).toContain("actions/setup-node@v4");
    expect(e2e).toMatch(/node-version:\s*["']?24["']?/);
    expect(e2e).toContain("npm ci");
    expect(e2e).toContain("./node_modules/.bin/playwright install --with-deps chromium");
    expect(e2e).toMatch(/^\s*run:\s*npm run test:e2e\s*$/m);
    expect(packageManifest.scripts["test:e2e"]).toBe("playwright test");
    expect(e2e).not.toMatch(credentialReference);
    expect(deploy).not.toContain("e2e");
  });

  it("deploys only successful main pushes with scoped credentials, migrations, and a health retry", () => {
    const workflow = workflowSource();
    const deploy = jobSource(workflow, "deploy");

    expect(deploy).toMatch(/needs:\s*ci/);
    expect(deploy).toMatch(/if:\s*github\.event_name == ['"]push['"] && github\.ref == ['"]refs\/heads\/main['"]/);
    expect(deploy).toMatch(/concurrency:\n\s+group:\s*production-deploy\n\s+cancel-in-progress:\s*false/);
    expect(deploy).toMatch(/permissions:\n\s+contents:\s*read/);
    expect(deploy).toContain("actions/checkout@v4");
    expect(deploy.indexOf("id: freshness")).toBeGreaterThan(deploy.indexOf("actions/checkout@v4"));
    expect(deploy).toContain("git ls-remote origin refs/heads/main");
    expect(deploy).toContain("$GITHUB_SHA");
    expect(deploy).toContain('echo "deploy=true" >> "$GITHUB_OUTPUT"');
    expect(deploy).toContain('echo "deploy=false" >> "$GITHUB_OUTPUT"');
    for (const action of ["Apply D1 migrations", "Deploy production Worker", "Verify production health"]) {
      expect(deploy).toMatch(new RegExp(`- name: ${action}\\n\\s+if: steps\\.freshness\\.outputs\\.deploy == ['"]true['"]`));
    }
    const migrationIndex = deploy.indexOf("- name: Apply D1 migrations");
    const deploymentIndex = deploy.indexOf("- name: Deploy production Worker");
    const healthIndex = deploy.indexOf("- name: Verify production health");
    expect(migrationIndex).toBeLessThan(deploymentIndex);
    expect(deploymentIndex).toBeLessThan(healthIndex);
    expect(deploy).toContain("actions/setup-node@v4");
    expect(deploy).toMatch(/node-version:\s*["']?24["']?/);
    expect(deploy).toContain("npm ci");
    expect(deploy.match(/\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/g)).toHaveLength(2);
    expect(deploy.match(/\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/g)).toHaveLength(2);
    expect(deploy).toContain("${{ vars.VITE_TURNSTILE_SITE_KEY }}");
    expect(deploy).toMatch(/CI:\s*["']?true["']?/);
    expect(deploy).toContain("./node_modules/.bin/wrangler d1 migrations apply DB --remote --config wrangler.jsonc");
    expect(deploy).toContain("npm run deploy:production");
    expect(deploy).toContain("https://officepool.football/health/app");
    expect(deploy).toMatch(/--connect-timeout\s+\d+/);
    expect(deploy).toMatch(/--max-time\s+\d+/);
    expect(deploy).toMatch(/for attempt in/);
    expect(deploy).toMatch(/http_code/);
  });
});
