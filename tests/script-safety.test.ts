import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareCredentialNames, workerSecretNames } from "../scripts/cloudflare-credentials.mjs";
import { isDirectExecution } from "../scripts/direct-entry.mjs";
import { waitForProcessGroupExit } from "../scripts/owned-process";
import { seedLocal } from "../scripts/seed-local";

const finishModule = await import(pathToFileURL(resolve(import.meta.dirname, "../scripts/run-finish-review.mjs")).href);
const finishDryRunEnvironment = (finishModule as { finishDryRunEnvironment: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv }).finishDryRunEnvironment;
const finishCommandStdio = (finishModule as { finishCommandStdio: (captureStdout: boolean) => string[] }).finishCommandStdio;
const runFinishCommand = (finishModule as { runFinishCommand: (command: string, args: string[], options: Record<string, unknown>) => Promise<{ status: number; stdout: string }> }).runFinishCommand;
const runFinishReview = (finishModule as { runFinishReview: (options: { root: string; environment: NodeJS.ProcessEnv; run: (command: string, args: string[], options: Record<string, unknown>) => Promise<{ status: number; stdout: string; stderr: string }> }) => Promise<void> }).runFinishReview;
const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const finishReviewEnvironment = async (root: string): Promise<NodeJS.ProcessEnv> => {
  const home = join(root, "home");
  const detectorDirectory = join(home, ".pi/agent/skills/impeccable/scripts");
  await mkdir(detectorDirectory, { recursive: true });
  // runFinishReview resolves this path, but these tests inject the command runner.
  await writeFile(join(detectorDirectory, "detect.mjs"), "");
  return { ...process.env, HOME: home, FINISH_REVIEW_RESUME: "0", FINISH_REVIEW_PHASE_C_COMPLETE: "0" };
};

const waitForFile = async (path: string) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 20)); }
  }
  throw new Error(`timed out waiting for ${path}`);
};

describe("script safety boundaries", () => {
  it("rejects non-loopback, HTTPS, and credential-bearing seed targets before fetching", async () => {
    const request = vi.fn<typeof fetch>();
    for (const target of ["https://127.0.0.1:8787", "http://example.com:8787", "http://user:secret@127.0.0.1:8787"]) {
      await expect(seedLocal(target, request)).rejects.toThrow(/credential-free HTTP loopback URL/);
    }
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(seedLocal("http://127.0.0.1:8787/base", request)).resolves.toBeUndefined();
    expect(String(request.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8787/__local-test/seed");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error" });

    request.mockImplementationOnce(async (_input, init) => {
      if (init?.redirect === "error") throw new TypeError("redirect mode is set to error");
      return new Response(null, { status: 302, headers: { location: "https://example.com/seed" } });
    });
    await expect(seedLocal("http://127.0.0.1:8787", request)).rejects.toThrow(/redirect mode is set to error/);
  });

  it("recognizes direct entries whose filesystem paths require URL encoding", () => {
    const entry = resolve(tmpdir(), "checkout with spaces # percent%.mjs");
    expect(isDirectExecution(pathToFileURL(entry).href, entry)).toBe(true);
    for (const relative of ["scripts/build-production.mjs", "scripts/deploy-production.mjs", "scripts/local-response-barrier.ts", "scripts/local-smoke.ts", "scripts/production-route-probe.ts", "scripts/verify-design-md.mjs"]) {
      expect(readFileSync(resolve(import.meta.dirname, "..", relative), "utf8"), relative).toContain("isDirectExecution(import.meta.url)");
    }
  });

  it("isolates finish-review dry runs from credentials, Worker secrets, dotenv, and process bindings", () => {
    const sensitiveNames = [...cloudflareCredentialNames, ...workerSecretNames];
    const input = Object.fromEntries(sensitiveNames.map((name) => [name, `secret-${name}`]));
    const clean = finishDryRunEnvironment({ PATH: "test", CLOUDFLARE_INCLUDE_PROCESS_ENV: "true", ...input });
    expect(clean).toMatchObject({ PATH: "test", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" });
    for (const name of sensitiveNames) expect(clean[name], name).toBeUndefined();
  });

  it("inherits ordinary finish output and tees detector stdout into bounded capture", async () => {
    expect(finishCommandStdio(false)).toEqual(["ignore", "inherit", "inherit"]);
    expect(finishCommandStdio(true)).toEqual(["ignore", "pipe", "inherit"]);
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write);
    try {
      const detector = await runFinishCommand(process.execPath, ["-e", "process.stdout.write('detector-json')"], { captureStdout: true });
      expect(detector).toEqual({ status: 0, stdout: "detector-json", stderr: "" });
      expect(output.join("")).toContain("detector-json");
    } finally { stdout.mockRestore(); }
  });

  it("invalidates stale detector completion and rejects empty output before replacing evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "share-value-pool-finish-detector-")); temporaryRoots.push(root);
    const artifacts = join(root, "artifacts");
    await mkdir(artifacts);
    await writeFile(join(artifacts, "detector.json"), "[{\"id\":\"stale\"}]\n");
    await writeFile(join(artifacts, "detector.exit"), "0\n");
    const run = vi.fn(async (_command: string, _args: string[], options: Record<string, unknown>) => ({ status: 0, stdout: options.captureStdout ? "" : "", stderr: "" }));
    await expect(runFinishReview({ root, environment: await finishReviewEnvironment(root), run })).rejects.toThrow(/no JSON output/);
    await expect(readFile(join(artifacts, "detector.exit"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(artifacts, "detector.json"), "utf8")).toContain("stale");
  });

  it("scrubs the detector environment, atomically publishes its evidence, and validates it before resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "share-value-pool-finish-detector-")); temporaryRoots.push(root);
    const detectorOutput = "[{\"id\":\"fresh\"}]\n";
    const sensitiveNames = [...cloudflareCredentialNames, ...workerSecretNames];
    const environment = { ...await finishReviewEnvironment(root), FINISH_REVIEW_ROOT: "/mismatched-review-root", CLOUDFLARE_INCLUDE_PROCESS_ENV: "true", ...Object.fromEntries(sensitiveNames.map((name) => [name, `secret-${name}`])) };
    const run = vi.fn(async (_command: string, _args: string[], options: Record<string, unknown>) => ({ status: 0, stdout: options.captureStdout ? detectorOutput : "", stderr: "" }));
    await runFinishReview({ root, environment, run });
    for (const call of run.mock.calls) {
      expect(call[2].cwd).toBe(root);
      expect(call[2].env).toMatchObject({
        FINISH_REVIEW_ROOT: root,
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      });
      for (const name of sensitiveNames) expect((call[2].env as NodeJS.ProcessEnv)[name], name).toBeUndefined();
    }
    expect(await readFile(join(root, "artifacts/detector.json"), "utf8")).toBe(detectorOutput);
    expect(await readFile(join(root, "artifacts/detector.exit"), "utf8")).toBe("0\n");
    await expect(readdir(join(root, "artifacts"))).resolves.toEqual(["detector.exit", "detector.json"]);

    await writeFile(join(root, "artifacts/detector.json"), "{}\n");
    await expect(runFinishReview({ root, environment: { ...environment, FINISH_REVIEW_RESUME: "1" }, run })).rejects.toThrow(/findings array/);
    await writeFile(join(root, "artifacts/detector.json"), "[{}]\n");
    await expect(runFinishReview({ root, environment: { ...environment, FINISH_REVIEW_RESUME: "1" }, run })).rejects.toThrow(/nonblank id/);
  });

  it("bounds a hanging finish child and removes its complete process group on abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "share-value-pool-finish-run-")); temporaryRoots.push(root);
    const marker = join(root, "pgid");
    const descendant = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
    const source = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
    const controller = new AbortController();
    const running = runFinishCommand(process.execPath, ["-e", source], { cwd: root, timeoutMs: 30_000, signal: controller.signal });
    const pgid = Number(await waitForFile(marker));
    controller.abort();
    await expect(running).rejects.toThrow(/interrupted/);
    await expect(waitForProcessGroupExit(pgid, 20, 50, { cleanupTimeoutMs: 5_000 })).resolves.toBe(true);
  }, 15_000);
});
