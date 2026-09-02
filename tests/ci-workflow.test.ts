import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(root, ".github/workflows/ci.yml");

const workflowSource = () => readFileSync(workflowPath, "utf8");
const jobSource = (workflow: string, job: string, nextJob?: string) => {
  const end = nextJob ? `(?=\\n  ${nextJob}:)` : "$";
  const match = workflow.match(new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)${end}`));
  expect(match, `${job} job must exist`).not.toBeNull();
  return match![1];
};

describe("GitHub Actions CI and production deployment", () => {
  it("runs CI for pull requests and main pushes without deployment credentials", () => {
    const workflow = workflowSource();
    const ci = jobSource(workflow, "ci", "deploy");

    expect(workflow).toMatch(/\non:\n  pull_request:\n  push:\n    branches: \[main\]/);
    expect(ci).toContain("actions/checkout@v4");
    expect(ci).toContain("actions/setup-node@v4");
    expect(ci).toMatch(/node-version:\s*["']?24["']?/);
    expect(ci).toContain("npm ci");
    expect(ci).toContain("npm test -- --maxWorkers=5");
    expect(ci).toContain("npm run typecheck");
    expect(ci).toContain("git diff --check");
    expect(ci).not.toMatch(/(?:secrets|vars)\.(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|VITE_TURNSTILE_SITE_KEY)/);
  });

  it("deploys only successful main pushes with scoped credentials, migrations, and a health retry", () => {
    const workflow = workflowSource();
    const deploy = jobSource(workflow, "deploy");

    expect(deploy).toMatch(/needs:\s*ci/);
    expect(deploy).toMatch(/if:\s*github\.event_name == ['"]push['"] && github\.ref == ['"]refs\/heads\/main['"]/);
    expect(deploy).toMatch(/concurrency:\n\s+group:\s*production-deploy\n\s+cancel-in-progress:\s*false/);
    expect(deploy).toMatch(/permissions:\n\s+contents:\s*read/);
    expect(deploy).toContain("actions/checkout@v4");
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
    expect(deploy).toMatch(/for attempt in/);
    expect(deploy).toMatch(/http_code/);
  });
});
