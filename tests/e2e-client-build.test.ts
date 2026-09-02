import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { localE2eClientBuildEnvironment } from "../scripts/e2e-client-build";

const root = resolve(import.meta.dirname, "..");

describe("local E2E client build environment", () => {
  it("keeps the Turnstile placeholder and scrubs dotenv-discoverable build inputs", () => {
    const input = {
      PATH: "test-path", VITE_TURNSTILE_SITE_KEY: "public-production-site-key", VITE_UNRELATED_SECRET: "do-not-serialize",
      BETTER_AUTH_SECRET: "do-not-forward", POOL_COMMAND_AUTHENTICATOR_KEY: "do-not-forward"
    };
    const environment = localE2eClientBuildEnvironment(input);
    expect(environment).toMatchObject({
      PATH: "test-path", VITE_TURNSTILE_SITE_KEY: "%VITE_TURNSTILE_SITE_KEY%",
      OFFICE_POOL_REBORN_E2E_BUILD: "true", OFFICE_POOL_REBORN_WORKER_CONFIG: resolve(root, "tests/fixtures/wrangler.test.jsonc"),
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false"
    });
    expect(environment.VITE_UNRELATED_SECRET).toBeUndefined();
    expect(environment.BETTER_AUTH_SECRET).toBeUndefined();
    expect(environment.POOL_COMMAND_AUTHENTICATOR_KEY).toBeUndefined();
    expect(input.VITE_TURNSTILE_SITE_KEY).toBe("public-production-site-key");
  });

  it("uses isolated Vite and Worker-test configuration rather than root dotenv discovery", () => {
    const vite = readFileSync(resolve(root, "vite.config.ts"), "utf8");
    const vitest = readFileSync(resolve(root, "vitest.config.ts"), "utf8");
    const fixture = readFileSync(resolve(root, "e2e/fixtures/local-worker.ts"), "utf8");
    const workerConfig = JSON.parse(readFileSync(resolve(root, "tests/fixtures/wrangler.test.jsonc"), "utf8")) as { main: string; d1_databases: Array<{ migrations_dir: string }> };
    expect(vite).toContain('OFFICE_POOL_REBORN_E2E_BUILD');
    expect(vite).toContain("envDir: viteEnvDir(e2eBuild, productionBuild)");
    expect(vitest).toContain('CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false"');
    expect(vitest).toContain('configPath: "./tests/fixtures/wrangler.test.jsonc"');
    expect(fixture).toContain('"--env-file", "/dev/null"');
    expect(fixture).toContain('localE2eClientBuildEnvironment(process.env)');
    expect(workerConfig).toMatchObject({ main: "../../src/index.ts", d1_databases: [{ migrations_dir: "../../src/db/migrations" }] });
  });
});
