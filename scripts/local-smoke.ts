import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupOwnedResources, createOwnerControl, installOwnedSignalCleanup, runOwnedProcess, stopOwnedProcess } from "./owned-process";

const STAGE_TIMEOUT_MS = 30_000;
const require = createRequire(import.meta.url);
const wrangler = require.resolve("wrangler");
const port = 24000 + Math.floor(Math.random() * 10000);
const persistence = await mkdtemp(join(tmpdir(), "share-value-pool-owned-smoke-"));
let base = `http://127.0.0.1:${port}`;
let child: ChildProcess | undefined;
let primaryFailure: unknown;
const control = createOwnerControl();

const bounded = async <T>(name: string, operation: Promise<T>, timeout = STAGE_TIMEOUT_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeout}ms`)), timeout); })]);
  } finally { if (timer) clearTimeout(timer); }
};
// Wrangler starts workerd descendants; use the same bounded TERM/KILL verification as every owned stage.
const stop = () => stopOwnedProcess(child);
let cleanupPromise: Promise<void> | undefined;
const cleanup = () => cleanupPromise ??= (async () => {
  if (control.enabled) { await control.cleanupEntered(); if (control.holdCleanup) await control.waitForCleanupHold(); if (!control.failBeforeReady) await control.waitForRelease(); }
  await cleanupOwnedResources({ child, primary: primaryFailure, label: "local smoke", stop, remove: () => rm(persistence, { recursive: true, force: true }) });
  if (control.enabled) await control.settled();
})();
const signalCleanup = installOwnedSignalCleanup({ cleanup });
// This owns its timeout and waits for TERM/KILL descendant cleanup before it settles.
const run = (command: string, args: string[]) => runOwnedProcess(command, args, STAGE_TIMEOUT_MS);
const request = async (path: string, user: string, body?: unknown) => bounded(path, (async () => {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: base, "content-type": "application/json", "x-local-test-user": user }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(STAGE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
})());
const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

try {
  // Wrangler's Vite integration serves the generated Worker entry; rebuild it for this isolated journey.
  await run("npm", ["run", "build:local"]);
  await run(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistence, "--config", "wrangler.local.jsonc"]);
  child = spawn(process.execPath, [wrangler, "dev", "--local", "--env-file", "/dev/null", `--port=${port}`, "--persist-to", persistence, "--config", "wrangler.local.jsonc", "--var", "BETTER_AUTH_SECRET:local-smoke-auth-secret-with-32-characters", "--var", "POOL_COMMAND_AUTHENTICATOR_KEY:local-smoke-command-authenticator", "--var", "POOL_PROJECTION_SERVICE_TOKEN:local-smoke-projection-token", "--var", "POOL_BACKUP_SERVICE_TOKEN:local-smoke-backup-token", "--var", "ALLOW_INSECURE_LOCAL_AUTH:true"], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } });
  const observe = (chunk: Buffer) => process.stdout.write(chunk);
  child.stdout?.on("data", observe); child.stderr?.on("data", observe);
  await control.resourceCreated({ pid: process.pid, pgid: child.pid!, persistence });
  control.throwIfFailBeforeReady();
  await bounded("local worker startup", (async () => {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${base}/health/app`, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch { /* Worker is still starting. */ }
      await delay(250);
    }
    throw new Error("local worker did not become ready through health polling");
  })());
  await control.ready({ pid: process.pid, pgid: child.pid!, persistence });
  if (control.enabled) await control.waitForCleanup();
  await run(process.execPath, [join(require.resolve("tsx"), "../cli.mjs"), "scripts/seed-local.ts", base]);

  const pool = await request("/api/pools", "local-owner", { slug: "local-smoke", poolName: "Local Smoke", password: "local-password", idempotencyKey: "create" });
  expect(pool.status === "ready", "pool creation did not converge");
  await request("/api/p/local-smoke/join", "local-member", { password: "local-password", idempotencyKey: "join" });
  await request("/api/p/local-smoke/admin/seasons", "local-owner", { seasonId: "local-2026", label: "Local 2026", idempotencyKey: "season" });
  await request("/api/p/local-smoke/admin/seasons/local-2026/open", "local-owner", { idempotencyKey: "open" });
  const fundingQuote = await request("/api/p/local-smoke/admin/orders/quote", "local-owner", { seasonId: "local-2026", memberId: "local-member", mode: "shares", amountMicros: "1000000", idempotencyKey: "fund-quote" });
  await request("/api/p/local-smoke/admin/orders/execute", "local-owner", { seasonId: "local-2026", memberId: "local-member", mode: "shares", amountMicros: "1000000", quote: fundingQuote, reason: "Deterministic local smoke funding", idempotencyKey: "fund" });

  const board = await request("/api/p/local-smoke/odds", "local-member");
  const offer = (board.offers as Array<Record<string, unknown>>).find((item) => item.eventId === "local-nfl-upcoming" && item.market === "spread");
  const home = (offer?.outcomes as Array<Record<string, unknown>> | undefined)?.find((item) => item.name === "Local Home");
  expect(offer && home, "local canonical spread offer was not available");
  const quoteKey = "local-quote"; const wagerId = "local-wager";
  const proposed = { quoteKey, commandId: quoteKey, wagerId, seasonId: "local-2026", riskMicros: "1000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: "local-nfl-upcoming", canonicalBook: String(offer.canonicalBook), market: "spread", selection: "home", offerId: `local-nfl-upcoming:spread:home`, offerVersion: String(offer.offerVersion) } };
  const quote = await request("/api/p/local-smoke/wagers/straight/quote", "local-member", proposed);
  expect(typeof quote.acceptedOdds === "number" && (quote.leg as Record<string, unknown>).canonicalBook === "DraftKings", "quote was not canonical");
  const leg = quote.leg as Record<string, unknown>;
  await request("/api/p/local-smoke/wagers/straight/place", "local-member", { commandId: "local-place", mutationKey: "local-place", wagerId, quoteKey, quotedCommandVersion: quote.commandVersion, seasonId: quote.seasonId, riskMicros: quote.riskMicros, acceptedOdds: quote.acceptedOdds, rulesetVersion: quote.rulesetVersion, leg });
  // The activity read shapes every member's tickets for the viewer; a nonowner starts without the unstarted leg.
  const hidden = await request("/api/p/local-smoke/activity", "local-owner");
  expect(!JSON.stringify(hidden).includes("Local Home"), "nonowner received an unstarted leg");

  const startsAt = String((quote.leg as Record<string, unknown>).eventStartsAt);
  const currentTime = new Date(new Date(startsAt).getTime() + 1_000).toISOString();
  // Advance the pool's fixture read clock past the accepted start: the nonowner read must reveal the leg.
  await request("/__local-test/current-time", "local-owner", { poolSlug: "local-smoke", currentTime });
  const revealed = await request("/api/p/local-smoke/activity", "local-owner");
  expect(JSON.stringify(revealed).includes("Local Home"), "advanced local read clock did not reveal the started leg");
  // Resetting the clock restores the real delayed-reveal boundary without touching accepted snapshots.
  await request("/__local-test/current-time", "local-owner", { poolSlug: "local-smoke", currentTime: null });
  const rehidden = await request("/api/p/local-smoke/activity", "local-owner");
  expect(!JSON.stringify(rehidden).includes("Local Home"), "reset local read clock did not restore delayed reveal");
  await request("/__local-test/result", "local-owner", { eventId: "local-nfl-upcoming", homeScore: 24, awayScore: 17 });
  await request("/__local-test/alarm", "local-owner", { poolSlug: "local-smoke", currentTime });
  const settled = await request("/api/p/local-smoke/wagers", "local-member");
  const wager = (settled.wagers as Array<Record<string, unknown>>).find((item) => item.wagerId === "local-wager");
  expect(wager?.status === "won", "settlement alarm did not settle the wager as won");
  const standings = await request("/api/p/local-smoke/standings", "local-member");
  const member = (standings.standings as Array<Record<string, unknown>>).find((item) => item.userId === "local-member");
  expect(member?.availableMicros === "2000000" && member.lockedMicros === "0", "settlement balances were not applied");
  const view = await request("/api/p/local-smoke/view", "local-member");
  expect((view.activeSeason as Record<string, unknown> | null)?.id === "local-2026", "season status changed unexpectedly after local settlement");
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  await signalCleanup.settled();
}
