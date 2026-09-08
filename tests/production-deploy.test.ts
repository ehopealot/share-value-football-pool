import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { cloudflareCredentialNames, workerSecretNames } from "../scripts/cloudflare-credentials.mjs";

const root = resolve(import.meta.dirname, "..");
type SpawnSync = (...args: unknown[]) => { status: number; error?: Error };
const deployModule = await import(pathToFileURL(resolve(root, "scripts/deploy-production.mjs")).href);
const deployProduction = (deployModule as { deployProduction?: (options: { cwd: string; environment: NodeJS.ProcessEnv; spawnSync: SpawnSync; buildProduction: () => void }) => void }).deployProduction;
const credentialNames = [...cloudflareCredentialNames];
const sensitiveNames = [...cloudflareCredentialNames, ...workerSecretNames];

const expectNoSensitiveBindings = (environment: NodeJS.ProcessEnv) => {
  for (const key of sensitiveNames) expect(environment).not.toHaveProperty(key);
};
const buildEnvironment = (buildProduction: ReturnType<typeof vi.fn>) => buildProduction.mock.calls[0][0].environment as NodeJS.ProcessEnv;

const environmentWithSecrets = (ci = false): NodeJS.ProcessEnv => ({
  ...(ci ? { CI: "true" } : {}),
  VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAEjUfp2Ub4CBu-E_",
  SENTRY_AUTH_TOKEN: "sourcemap-token",
  SENTRY_ORG: "sentry-org",
  SENTRY_PROJECT: "sentry-project",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
  BETTER_AUTH_SECRET: "production-secret",
  CLOUDFLARE_API_TOKEN: "token",
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  CF_API_TOKEN: "legacy-token",
  CLOUDFLARE_API_KEY: "global-key",
  CF_API_KEY: "legacy-global-key",
  CLOUDFLARE_EMAIL: "operator@example.test",
  CF_EMAIL: "legacy@example.test",
  CLOUDFLARE_API_USER_SERVICE_KEY: "service-key",
});

const expectIsolatedNonPublishingEnvironment = (environment: NodeJS.ProcessEnv) => {
  expectNoSensitiveBindings(environment);
  expect(environment).toMatchObject({ CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" });
};

describe("guarded production deployment", () => {
  it("builds with the production guard, verifies the artifact, then deploys without inherited secrets locally", () => {
    expect(deployProduction).toEqual(expect.any(Function));
    const spawnSync: SpawnSync = vi.fn(() => ({ status: 0 }));
    const buildProduction = vi.fn();

    deployProduction!({ cwd: root, environment: environmentWithSecrets(), spawnSync, buildProduction });

    expect(buildProduction).toHaveBeenCalledOnce();
    expect(buildProduction.mock.invocationCallOrder[0]).toBeLessThan((spawnSync as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expectIsolatedNonPublishingEnvironment(buildEnvironment(buildProduction));
    expect(spawnSync).toHaveBeenNthCalledWith(1, expect.stringMatching(/node_modules[/\\]\.bin[/\\]wrangler$/), ["deploy", "--dry-run", "--outdir", "dist-local", "--config", "wrangler.local.jsonc"], expect.objectContaining({ cwd: root }));
    expect(spawnSync).toHaveBeenNthCalledWith(2, process.execPath, [resolve(root, "scripts/verify-production-artifact.mjs")], expect.objectContaining({ cwd: root }));
    expect(spawnSync).toHaveBeenNthCalledWith(3, expect.stringMatching(/node_modules[/\\]\.bin[/\\]wrangler$/), ["deploy", "--keep-vars", "--config", "dist/office_pool_reborn/wrangler.json"], expect.objectContaining({ cwd: root }));
    for (const call of (spawnSync as ReturnType<typeof vi.fn>).mock.calls) {
      expectNoSensitiveBindings(call[2].env);
      expect(call[2].env.SENTRY_AUTH_TOKEN).toBeUndefined();
      expect(call[2].env.SENTRY_ORG).toBeUndefined();
      expect(call[2].env.SENTRY_PROJECT).toBeUndefined();
    }
    for (const call of (spawnSync as ReturnType<typeof vi.fn>).mock.calls.slice(0, 2)) expectIsolatedNonPublishingEnvironment(call[2].env);
  });

  it("preserves CI credentials only for the production Wrangler subprocess", () => {
    expect(deployProduction).toEqual(expect.any(Function));
    const spawnSync: SpawnSync = vi.fn(() => ({ status: 0 }));
    const buildProduction = vi.fn();

    deployProduction!({ cwd: root, environment: environmentWithSecrets(true), spawnSync, buildProduction });

    expectIsolatedNonPublishingEnvironment(buildEnvironment(buildProduction));
    const calls = (spawnSync as ReturnType<typeof vi.fn>).mock.calls;
    expectIsolatedNonPublishingEnvironment(calls[0][2].env);
    expectIsolatedNonPublishingEnvironment(calls[1][2].env);
    const productionWrangler = calls[2][2].env;
    expect(productionWrangler).toMatchObject({
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    });
    for (const key of credentialNames.filter((name) => name !== "CLOUDFLARE_API_TOKEN" && name !== "CLOUDFLARE_ACCOUNT_ID")) expect(productionWrangler).not.toHaveProperty(key);
    for (const key of workerSecretNames) expect(productionWrangler).not.toHaveProperty(key);
  });
});
