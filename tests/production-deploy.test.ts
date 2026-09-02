import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const root = resolve(import.meta.dirname, "..");
type SpawnSync = (...args: unknown[]) => { status: number; error?: Error };
const deployModule = await import(pathToFileURL(resolve(root, "scripts/deploy-production.mjs")).href).catch(() => ({}));
const deployProduction = (deployModule as { deployProduction?: (options: { cwd: string; environment: NodeJS.ProcessEnv; spawnSync: SpawnSync; buildProduction: () => void }) => void }).deployProduction;
const credentialNames = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL", "CLOUDFLARE_API_USER_SERVICE_KEY"];

const expectNoCloudflareCredentials = (environment: NodeJS.ProcessEnv) => {
  for (const key of credentialNames) expect(environment).not.toHaveProperty(key);
};

const expectSubprocessesHaveNoCloudflareCredentials = (spawnSync: SpawnSync) => {
  for (const call of (spawnSync as ReturnType<typeof vi.fn>).mock.calls) expectNoCloudflareCredentials(call[2].env);
};

const buildEnvironment = (buildProduction: ReturnType<typeof vi.fn>) => buildProduction.mock.calls[0][0].environment as NodeJS.ProcessEnv;

describe("guarded production deployment", () => {
  it("builds with the production guard, verifies the artifact, then deploys with OAuth-only variables locally", () => {
    expect(deployProduction).toEqual(expect.any(Function));
    const spawnSync: SpawnSync = vi.fn(() => ({ status: 0 }));
    const buildProduction = vi.fn();

    deployProduction!({ cwd: root, environment: { VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAEjUfp2Ub4CBu-E_", CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "account-id", CF_API_TOKEN: "legacy-token", CLOUDFLARE_API_KEY: "global-key", CF_API_KEY: "legacy-global-key", CLOUDFLARE_EMAIL: "operator@example.test", CF_EMAIL: "legacy@example.test", CLOUDFLARE_API_USER_SERVICE_KEY: "service-key" }, spawnSync, buildProduction });

    expect(buildProduction).toHaveBeenCalledOnce();
    expectNoCloudflareCredentials(buildEnvironment(buildProduction));
    expect(spawnSync).toHaveBeenNthCalledWith(1, expect.stringMatching(/node_modules[/\\]\.bin[/\\]wrangler$/), ["deploy", "--dry-run", "--outdir", "dist-local", "--config", "wrangler.local.jsonc"], expect.objectContaining({ cwd: root }));
    expect(spawnSync).toHaveBeenNthCalledWith(2, process.execPath, [resolve(root, "scripts/verify-production-artifact.mjs")], expect.objectContaining({ cwd: root }));
    expect(spawnSync).toHaveBeenNthCalledWith(3, expect.stringMatching(/node_modules[/\\]\.bin[/\\]wrangler$/), ["deploy", "--keep-vars", "--config", "dist/office_pool_reborn/wrangler.json"], expect.objectContaining({ cwd: root }));
    expectSubprocessesHaveNoCloudflareCredentials(spawnSync);
  });

  it("preserves only the API token and account ID for Wrangler subprocesses in CI", () => {
    expect(deployProduction).toEqual(expect.any(Function));
    const spawnSync: SpawnSync = vi.fn(() => ({ status: 0 }));
    const buildProduction = vi.fn();
    const environment = { CI: "true", VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAEjUfp2Ub4CBu-E_", CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "account-id", CF_API_TOKEN: "legacy-token", CLOUDFLARE_API_KEY: "global-key", CF_API_KEY: "legacy-global-key", CLOUDFLARE_EMAIL: "operator@example.test", CF_EMAIL: "legacy@example.test", CLOUDFLARE_API_USER_SERVICE_KEY: "service-key" };

    deployProduction!({ cwd: root, environment, spawnSync, buildProduction });

    expectNoCloudflareCredentials(buildEnvironment(buildProduction));
    const calls = (spawnSync as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of [calls[0], calls[2]]) {
      expect(call[2].env).toHaveProperty("CLOUDFLARE_API_TOKEN", "token");
      expect(call[2].env).toHaveProperty("CLOUDFLARE_ACCOUNT_ID", "account-id");
      for (const key of credentialNames.filter((name) => name !== "CLOUDFLARE_API_TOKEN" && name !== "CLOUDFLARE_ACCOUNT_ID")) expect(call[2].env).not.toHaveProperty(key);
    }
    for (const key of credentialNames) expect(calls[1][2].env).not.toHaveProperty(key);
  });
});
