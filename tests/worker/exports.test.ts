import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkerApp } from "../../src/worker/app";
import { backupConfigured, backupPools, decodeBackupKey, encryptBackup } from "../../src/worker/backup-cron";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace; BACKUPS: R2Bucket; POOL_COMMAND_AUTHENTICATOR_KEY: string; POOL_BACKUP_SERVICE_TOKEN: string };
let migrated = false;
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

async function pool(poolId: string, slug: string): Promise<void> {
  await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, slug, poolId, `create-${poolId}`, new Date().toISOString()).run();
  const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId));
  await stub.fetch("https://pool.internal/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "InitializePool", commandId: `init-${poolId}`, poolId, slug, creatorId: "owner", creatorName: "Owner", poolName: "Export Pool", password: "correct-password" }) });
  await stub.fetch("https://pool.internal/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "JoinPool", commandId: `join-${poolId}`, actorId: "member", displayName: "Member", password: "correct-password" }) });
  await stub.fetch("https://pool.internal/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "JoinPool", commandId: `viewer-${poolId}`, actorId: "viewer", displayName: "Viewer", password: "correct-password" }) });
}

const stateFor = <T>(poolId: string, callback: (state: DurableObjectState) => T) => runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (_instance, state) => callback(state));

beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await bindings.DB.exec("DELETE FROM backup_cursor; DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner@example.test', 1, 0, 0), ('member', 'Member', 'member@example.test', 1, 0, 0), ('viewer', 'Viewer', 'viewer@example.test', 1, 0, 0), ('outsider', 'Outsider', 'outsider@example.test', 1, 0, 0);");
});

describe("member export and encrypted infrastructure backup", () => {
  it("rejects malformed authoritative ReadPoolView data at the odds authorization boundary", async () => {
    const poolId = `invalid-view-${crypto.randomUUID()}`;
    await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, "invalid-view-pool", poolId, `create-${poolId}`, new Date().toISOString()).run();
    const pools = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ commandVersion: "1" }) }) } as unknown as DurableObjectNamespace;
    const app = createWorkerApp({ db: bindings.DB, pools, currentUser: async () => ({ id: "member", name: "Member" }) });
    const response = await app.fetch(new Request("https://pool.example.test/api/p/invalid-view-pool/odds"));
    expect(response.status).toBe(400);
    expect(await response.json()).not.toMatchObject({ offers: expect.anything() });
  });

  it("rejects malformed owner wager settlement odds at the Worker response boundary", async () => {
    const poolId = `invalid-my-wagers-${crypto.randomUUID()}`;
    await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, "invalid-my-wagers-pool", poolId, `create-${poolId}`, new Date().toISOString()).run();
    const malformed = { commandVersion: "1", wagers: [{ wagerId: "w", seasonId: "s", memberId: "member", memberDisplayName: "Member", type: "parlay", status: "won", confirmedAt: "2026-01-01T00:00:00.000Z", weekStart: "2025-12-30T05:00:00.000Z", performanceMicros: "2500000", riskMicros: "1000000", acceptedOdds: 250, rulesetVersion: "PARLAY_2026_V1", outcome: "won", returnMicros: "3500000", profitMicros: "2500000", settledOdds: "250", settledAt: "2026-01-02T00:00:00.000Z" }] };
    const pools = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json(malformed) }) } as unknown as DurableObjectNamespace;
    const app = createWorkerApp({ db: bindings.DB, pools, currentUser: async () => ({ id: "member", name: "Member" }) });
    const response = await app.fetch(new Request("https://pool.example.test/api/p/invalid-my-wagers-pool/wagers"));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("code");
  });

  it("rejects missing and malformed result evidence at the Worker response boundary", async () => {
    const poolId = `invalid-audit-${crypto.randomUUID()}`;
    await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, "invalid-audit-pool", poolId, `create-${poolId}`, new Date().toISOString()).run();
    const providerResults = [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 24, awayScore: 17, correctionVersion: "1" }];
    const settlement = { id: "settlement", wagerId: "w", resultVersion: '[["event-1","1"]]', outcome: "win", returnMicros: "2000000", profitMicros: "1000000", settledOdds: 100, sourceResult: providerResults, reversalOf: null, actorId: "system", reason: null, createdAt: "2026-01-01T00:00:00.000Z" };
    const replacementResult = { source: "commissioner_correction", commandId: "command", correctedResults: providerResults, derived: { outcome: "win", odds: 100 } };
    const correction = { id: "correction", wagerId: "w", actorId: "owner", reason: "Official correction", sourceResult: providerResults, replacementResult, commandId: "command", createdAt: "2026-01-01T00:00:00.000Z" };
    const base = { format: "share-value-pool-audit-v1", commandVersion: "1", pool: { id: poolId, slug: "invalid-audit-pool", name: "Pool", commissionerId: "owner", signupsOpen: true, commandVersion: "1" }, seasons: [], seasonProviderResults: [], accounts: [], orders: [], ledger: [], settlements: [settlement], wagerCorrections: [correction], administrationAudit: [], seasonAnnotations: [], wagers: [] };
    const { sourceResult: _missingSource, ...settlementWithoutSource } = settlement;
    const { replacementResult: _missingReplacement, ...correctionWithoutReplacement } = correction;
    const malformedExports = [
      { ...base, settlements: [{ ...settlement, sourceResult: "unvalidated provider evidence" }] },
      { ...base, settlements: [settlementWithoutSource] },
      { ...base, wagerCorrections: [{ ...correction, replacementResult: { source: "commissioner_correction", commandId: "command", correctedResults: providerResults, derived: { outcome: "win", odds: null } } }] },
      { ...base, wagerCorrections: [correctionWithoutReplacement] }
    ];
    for (const malformed of malformedExports) {
      const pools = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json(malformed) }) } as unknown as DurableObjectNamespace;
      const app = createWorkerApp({ db: bindings.DB, pools, currentUser: async () => ({ id: "member", name: "Member" }) });
      const response = await app.fetch(new Request("https://pool.example.test/api/p/invalid-audit-pool/export"));
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("code");
    }
  });

  it("allows only an authenticated authoritative member export and does not leak hidden picks", async () => {
    const poolId = `export-${crypto.randomUUID()}`;
    await pool(poolId, "export-pool");
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => ({ id: "member", name: "Member" }) });
    const response = await app.fetch(new Request("https://pool.example.test/api/p/export-pool/export"));
    const body = await response.json() as { format: string; pool: { id: string }; ledger: unknown[]; wagers: unknown[]; code?: string };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.format).toBe("share-value-pool-audit-v1");
    expect(body.pool.id).toBe(poolId);
    expect(body.ledger).toEqual([]);
    expect(body.wagers).toEqual([]);

    const denied = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => ({ id: "outsider", name: "Outsider" }) });
    expect((await denied.fetch(new Request("https://pool.example.test/api/p/export-pool/export"))).status).toBe(403);
    const anonymous = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => null });
    expect((await anonymous.fetch(new Request("https://pool.example.test/api/p/export-pool/export"))).status).toBe(401);
    expect(await (await app.fetch(new Request("https://pool.example.test/health/backups"))).json()).toEqual({ status: "disabled" });
  }, 90_000);

  it("exports exact audit history while preserving member-level hidden-pick redaction", async () => {
    const poolId = `audit-${crypto.randomUUID()}`;
    await pool(poolId, "audit-pool");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await stateFor(poolId, (state) => {
      state.storage.deleteAlarm();
      state.storage.sql.exec(`
      INSERT INTO season (id, label, ruleset_version, state, created_at, opened_at, closed_at, close_reason, float_micros, notional_micros, default_mode, default_amount_micros, command_version) VALUES ('s0', '2025', 'SHARE_POOL_2025_FINAL', 'closed', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-02-10T04:00:00.000Z', 'super_bowl_final', '0', '0', NULL, NULL, '8');
      INSERT INTO season (id, label, ruleset_version, state, created_at, opened_at, closed_at, close_reason, float_micros, notional_micros, default_mode, default_amount_micros, command_version) VALUES ('s1', '2026', 'SHARE_POOL_2026_V1', 'active', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, '900719925474099312345678', '900719925474099312345679', NULL, NULL, '9');
      INSERT INTO season_provider_result VALUES ('s0', 'super-bowl', 'nfl', 'official-1', '{"eventId":"super-bowl","league":"nfl","status":"final","homeScore":24,"awayScore":20,"correctionVersion":"official-1","eventName":"Super Bowl","postseason":true}', '2025-02-10T04:00:00.000Z', 1);
      INSERT INTO season_provider_result VALUES ('s0', 'super-bowl', 'nfl', 'official-2', '{"eventId":"super-bowl","league":"nfl","status":"final","homeScore":24,"awayScore":22,"correctionVersion":"official-2","eventName":"Super Bowl","postseason":true}', '2025-02-10T05:00:00.000Z', 2);
      INSERT INTO season_provider_result VALUES ('s1', 'super-bowl', 'nfl', 'official-1', '{"eventId":"super-bowl","league":"nfl","status":"final","homeScore":24,"awayScore":20,"correctionVersion":"official-1","eventName":"Super Bowl","postseason":true}', '2026-02-09T04:00:00.000Z', 1);
      INSERT INTO share_account VALUES ('s1', 'member', '900719925474099312345678', '1000000', '4');
      INSERT INTO share_account VALUES ('s1', 'owner', '0', '0', '1');
      INSERT INTO share_order VALUES ('fund', 's1', 'member', 'owner', 'shares', '900719925474099312345678', '900719925474099312345678', '900719925474099312345678', '1000000', NULL, 'large virtual funding', 'fund-command', '2026-01-01T00:00:00.000Z');
      INSERT INTO ledger_entry VALUES ('ledger-fund', 's1', 'member', 'owner', '900719925474099312345678', '0', '900719925474099312345678', '900719925474099312345678', 'fund', 'share_order', '2026-01-01T00:00:00.000Z');
      INSERT INTO ledger_entry VALUES ('z-ledger-reversal', 's1', 'member', 'owner', '1000000', '-1000000', '0', '0', 'z-reversal', 'settlement_reversal', '2026-01-03T00:00:00.000Z');
      INSERT INTO ledger_entry VALUES ('a-ledger-replacement', 's1', 'member', 'owner', '-1000000', '0', '0', '-1000000', 'a-regrade', 'settlement', '2026-01-03T00:00:00.000Z');
      INSERT INTO wager VALUES ('straight-hidden', 's1', 'member', 'straight', '1000000', 100, 'lost', 'SHARE_POOL_2026_V1', 'commissioner:correction-command:[["hidden-straight","official-2"]]', '2026-01-02T00:00:00.000Z');
      INSERT INTO wager VALUES ('teaser-partial', 's1', 'member', 'teaser', '1000000', -120, 'open', 'SHARE_POOL_2026_V1', NULL, '2026-01-02T00:00:00.000Z');
      INSERT INTO wager VALUES ('parlay-settled', 's1', 'member', 'parlay', '1000000', 300, 'won', 'PARLAY_2026_V1', '[["parlay-started","provider-1"]]', '2026-01-02T00:00:00.000Z');
      INSERT INTO wager_leg VALUES ('straight-leg', 'straight-hidden', 'hidden-straight', 'nfl', 'DraftKings', '2026-01-01T00:00:00.000Z', 'policy', 'offer', NULL, NULL, 'spread', 'home', '-3.5', -110, NULL, NULL, '1970-01-01T00:00:00.000Z', 0, 'loss', 'provider-1');
      INSERT INTO wager_leg VALUES ('teaser-started', 'teaser-partial', 'revealed-leg', 'nfl', 'DraftKings', '2026-01-01T00:00:00.000Z', 'policy', 'offer', NULL, NULL, 'spread', 'away', '3.5', -110, '6', '9.5', '1970-01-01T00:00:00.000Z', 0, NULL, NULL);
      INSERT INTO wager_leg VALUES ('teaser-hidden', 'teaser-partial', 'future-leg', 'ncaaf', 'FanDuel', '2026-01-01T00:00:00.000Z', 'policy', 'offer', NULL, NULL, 'total', 'under', '50.5', -110, '6', '56.5', '${future}', 0, NULL, NULL);
      INSERT INTO wager_leg VALUES ('parlay-started-leg', 'parlay-settled', 'parlay-started', 'nfl', 'DraftKings', '2026-01-01T00:00:00.000Z', 'policy', 'offer', NULL, NULL, 'spread', 'home', '-3', 100, NULL, NULL, '1970-01-01T00:00:00.000Z', 0, 'win', 'provider-1');
      INSERT INTO wager_leg VALUES ('parlay-future-leg', 'parlay-settled', 'parlay-future', 'ncaaf', 'FanDuel', '2026-01-01T00:00:00.000Z', 'policy', 'offer', NULL, NULL, 'total', 'under', '50.5', -110, NULL, NULL, '${future}', 0, 'win', 'provider-1');
      INSERT INTO settlement (id, wager_id, result_version, outcome, return_micros, profit_micros, settled_odds, source_result_json, reversal_of, actor_id, reason, created_at) VALUES ('settlement', 'straight-hidden', '[["hidden-straight","provider-1"]]', 'refund', '1000000', '0', NULL, '[{"eventId":"hidden-straight","league":"nfl","status":"cancelled","homeScore":null,"awayScore":null,"correctionVersion":"provider-1","eventName":null,"postseason":false}]', NULL, 'owner', 'manual correction', '2026-01-03T00:00:00.000Z');
      INSERT INTO settlement (id, wager_id, result_version, outcome, return_micros, profit_micros, settled_odds, source_result_json, reversal_of, actor_id, reason, created_at) VALUES ('z-reversal', 'straight-hidden', '[["hidden-straight","provider-1"]]', 'reversal', '-1000000', '0', NULL, '[{"eventId":"hidden-straight","league":"nfl","status":"cancelled","homeScore":null,"awayScore":null,"correctionVersion":"provider-1","eventName":null,"postseason":false}]', 'settlement', 'owner', 'review reversal', '2026-01-03T00:00:00.000Z');
      INSERT INTO settlement (id, wager_id, result_version, outcome, return_micros, profit_micros, settled_odds, source_result_json, reversal_of, actor_id, reason, created_at) VALUES ('a-regrade', 'straight-hidden', 'commissioner:correction-command:[["hidden-straight","official-2"]]', 'loss', '0', '0', NULL, '{"source":"commissioner_correction","commandId":"correction-command","correctedResults":[{"eventId":"hidden-straight","league":"nfl","status":"final","homeScore":17,"awayScore":24,"correctionVersion":"official-2"}],"derived":{"outcome":"loss","odds":null}}', NULL, 'owner', 'review regrade', '2026-01-03T00:00:00.000Z');
      INSERT INTO settlement (id, wager_id, result_version, outcome, return_micros, profit_micros, settled_odds, source_result_json, reversal_of, actor_id, reason, created_at) VALUES ('parlay-settlement', 'parlay-settled', '[["parlay-started","provider-1"]]', 'win', '3500000', '2500000', 250, '[{"eventId":"parlay-started","league":"nfl","status":"final","homeScore":24,"awayScore":17,"correctionVersion":"provider-1"}]', NULL, 'system', NULL, '2026-01-03T00:00:00.000Z');
      INSERT INTO wager_correction VALUES ('z-correction', 'straight-hidden', 'owner', 'bad provider result', '[{"eventId":"hidden-straight","league":"nfl","status":"cancelled","homeScore":null,"awayScore":null,"correctionVersion":"provider-1","eventName":null,"postseason":false}]', '{"source":"commissioner_correction","commandId":"correction-command","correctedResults":[{"eventId":"hidden-straight","league":"nfl","status":"final","homeScore":17,"awayScore":24,"correctionVersion":"official-2"}],"derived":{"outcome":"loss","odds":null}}', 'correction-command', '2026-01-03T00:00:00.000Z');
      INSERT INTO wager_correction VALUES ('a-correction', 'straight-hidden', 'owner', 'final provider result', '{"source":"commissioner_correction","commandId":"correction-command","correctedResults":[{"eventId":"hidden-straight","league":"nfl","status":"final","homeScore":17,"awayScore":24,"correctionVersion":"official-2"}],"derived":{"outcome":"loss","odds":null}}', '{"source":"commissioner_void","commandId":"correction-command-2","outcome":"refund"}', 'correction-command-2', '2026-01-03T00:00:00.000Z');
      INSERT INTO administration_audit VALUES ('admin-audit', 'owner', 'regrade_wager', 'straight-hidden', 'bad provider result', 'correction-command', '2026-01-03T00:00:00.000Z');
      INSERT INTO season_annotation VALUES ('annotation', 's1', 'owner', 'season note', '2026-01-03T00:00:00.000Z');
    `);
    });
    const exported = async (id: string) => (await createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => ({ id, name: id }) }).fetch(new Request("https://pool.example.test/api/p/audit-pool/export"))).json() as Promise<Record<string, unknown>>;
    const owner = await exported("member");
    expect(owner.seasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "s0", rulesetVersion: "SHARE_POOL_2025_FINAL", closeReason: "super_bowl_final" }),
      expect.objectContaining({ id: "s1", rulesetVersion: "SHARE_POOL_2026_V1" })
    ]));
    expect(owner.seasonProviderResults).toEqual([
      expect.objectContaining({ seasonId: "s0", eventId: "super-bowl", correctionVersion: "official-1", appendOrder: "1", result: expect.objectContaining({ homeScore: 24, awayScore: 20 }) }),
      expect.objectContaining({ seasonId: "s0", eventId: "super-bowl", correctionVersion: "official-2", appendOrder: "2", result: expect.objectContaining({ homeScore: 24, awayScore: 22 }) }),
      expect.objectContaining({ seasonId: "s1", eventId: "super-bowl", correctionVersion: "official-1", appendOrder: "1", result: expect.objectContaining({ homeScore: 24, awayScore: 20 }) })
    ]);
    expect(owner.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ availableMicros: "900719925474099312345678" })]));
    expect(owner.orders).toEqual(expect.arrayContaining([expect.objectContaining({ sharesMicros: "900719925474099312345678" })]));
    expect(owner.ledger).toEqual(expect.arrayContaining([expect.objectContaining({ availableDelta: "900719925474099312345678" })]));
    // Reverse-lexical UUID-like IDs prove tied timestamps retain append/causal rowid order.
    expect((owner.ledger as Array<{ id: string }>).map(({ id }) => id)).toEqual(["ledger-fund", "z-ledger-reversal", "a-ledger-replacement"]);
    expect(owner.settlements).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: "owner", reason: "manual correction", settledOdds: null })]));
    // Millisecond timestamps can tie inside one correction command; every contractual chronological array retains append order.
    expect((owner.settlements as Array<{ id: string }>).map(({ id }) => id)).toEqual(["settlement", "z-reversal", "a-regrade", "parlay-settlement"]);
    expect((owner.wagerCorrections as Array<{ id: string }>).map(({ id }) => id)).toEqual(["z-correction", "a-correction"]);
    expect(owner).toMatchObject({ administrationAudit: [expect.objectContaining({ id: "admin-audit" })], seasonAnnotations: [expect.objectContaining({ id: "annotation" })] });
    const ownerWagers = owner.wagers as Array<Record<string, unknown>>;
    expect(ownerWagers).toEqual(expect.arrayContaining([
      expect.objectContaining({ wagerId: "straight-hidden", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", outcome: "lost", returnMicros: "0", profitMicros: "0", settledOdds: null, settledAt: "2026-01-03T00:00:00.000Z" }),
      expect.objectContaining({ wagerId: "teaser-partial", riskMicros: "1000000", acceptedOdds: -120, rulesetVersion: "SHARE_POOL_2026_V1" }),
      expect.objectContaining({ wagerId: "parlay-settled", type: "parlay", riskMicros: "1000000", acceptedOdds: 300, rulesetVersion: "PARLAY_2026_V1", outcome: "won", settledOdds: 250 })
    ]));
    expect(JSON.stringify(ownerWagers)).toContain("hidden-straight");
    expect(JSON.stringify(ownerWagers)).toContain("revealed-leg");
    expect(JSON.stringify(ownerWagers)).not.toContain("future-leg");
    expect(JSON.stringify(ownerWagers)).not.toContain("parlay-future");
    for (const viewer of ["viewer", "owner"]) {
      const viewerExport = await exported(viewer);
      expect(viewerExport.seasonProviderResults).toEqual(owner.seasonProviderResults);
      const wagers = viewerExport.wagers as Array<Record<string, unknown>>;
      const body = JSON.stringify(wagers);
      expect(body).toContain("revealed-leg");
      expect(body).toContain("hidden-straight");
      expect(body).not.toContain("future-leg");
      expect(body).not.toContain("parlay-future");
      expect(wagers.find((wager) => wager.wagerId === "straight-hidden")).not.toHaveProperty("riskMicros");
      expect(wagers.find((wager) => wager.wagerId === "straight-hidden")).not.toHaveProperty("outcome");
    }
  }, 90_000);

  it("strictly validates backup keys and stores independently nonce-encrypted self-describing envelopes", async () => {
    expect(() => decodeBackupKey("not base64")).toThrow("BACKUP_KEY_INVALID");
    expect(() => decodeBackupKey(btoa("short"))).toThrow("BACKUP_KEY_INVALID");
    expect(backupConfigured({ BACKUP_ENCRYPTION_KEY: key })).toBe(false);
    const first = await encryptBackup({ format: "share-value-pool-audit-v1", value: "exact" }, decodeBackupKey(key));
    const second = await encryptBackup({ format: "share-value-pool-audit-v1", value: "exact" }, decodeBackupKey(key));
    expect(first).toMatchObject({ format: "share-value-pool-backup-aes-gcm-v1", algorithm: "AES-GCM", nonce: expect.any(String), ciphertext: expect.any(String) });
    expect(first.nonce).not.toBe(second.nonce);

    const poolId = `backup-${crypto.randomUUID()}`;
    await pool(poolId, "backup-pool");
    await stateFor(poolId, (state) => state.storage.sql.exec(`
      INSERT INTO season (id, label, ruleset_version, state, created_at, opened_at, closed_at, close_reason, float_micros, notional_micros, default_mode, default_amount_micros, command_version) VALUES ('backup-season', 'Backup Season', 'SHARE_POOL_BACKUP_V1', 'closed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-02-09T04:00:00.000Z', 'super_bowl_final', '0', '0', NULL, NULL, '2');
      INSERT INTO season_provider_result VALUES ('backup-season', 'backup-super-bowl', 'nfl', 'official-1', '{"eventId":"backup-super-bowl","league":"nfl","status":"final","homeScore":31,"awayScore":27,"correctionVersion":"official-1","eventName":"Super Bowl","postseason":true}', '2026-02-09T04:00:00.000Z', 1);
      INSERT INTO wager VALUES ('backup-hidden', 'backup-season', 'member', 'teaser', '2500000', 125, 'open', 'SHARE_POOL_BACKUP_V1', NULL, '2026-01-02T00:00:00.000Z');
      INSERT INTO wager_leg VALUES ('backup-hidden:z', 'backup-hidden', 'protected-future-z', 'nfl', 'DraftKings', '2026-01-02T00:00:00.000Z', 'policy', 'offer-z', NULL, NULL, 'spread', 'home', '-2.5', -110, '6', '3.5', '2099-01-02T00:00:00.000Z', 0, NULL, NULL);
      INSERT INTO wager_leg VALUES ('backup-hidden:a', 'backup-hidden', 'protected-future-a', 'ncaaf', 'FanDuel', '2026-01-02T00:00:00.000Z', 'policy', 'offer-a', NULL, NULL, 'total', 'under', '44.5', -110, '6', '50.5', '2099-01-01T00:00:00.000Z', 0, NULL, NULL);
      INSERT INTO wager_leg_snapshot VALUES ('backup-hidden:z', 'Zebras', 'Yaks');
      INSERT INTO wager_leg_snapshot VALUES ('backup-hidden:a', 'Águilas', 'Bears');
      INSERT INTO message_board_entry (id, parent_post_id, author_id, text, created_at, activity_at, is_announcement) VALUES ('backup-board-post', NULL, 'member', 'Backup top-level post', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:01.000Z', 1);
      INSERT INTO message_board_entry (id, parent_post_id, author_id, text, created_at, activity_at, is_announcement) VALUES ('backup-board-reply', 'backup-board-post', 'viewer', 'Backup reply', '2026-01-03T00:00:01.000Z', '2026-01-03T00:00:01.000Z', 0);
      INSERT INTO message_board_read VALUES ('member', '2026-01-03T00:00:01.000Z');
      INSERT INTO message_board_read VALUES ('viewer', '2026-01-03T00:00:00.000Z');
    `));
    const memberResponse = await createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => ({ id: "viewer", name: "Viewer" }) }).fetch(new Request("https://pool.example.test/api/p/backup-pool/export"));
    const memberExport = await memberResponse.json() as Record<string, unknown>;
    expect(memberResponse.status).toBe(200);
    expect(memberExport).not.toHaveProperty("wagerLegSnapshots");
    expect(memberExport).not.toHaveProperty("messageBoardEntries");
    expect(memberExport).not.toHaveProperty("messageBoardReadStates");
    expect(memberExport.wagers).toEqual([{
      wagerId: "backup-hidden", seasonId: "backup-season", memberId: "member", memberDisplayName: "Member", type: "teaser", status: "open", confirmedAt: "2026-01-02T00:00:00.000Z", weekStart: "2098-12-30T05:00:00.000Z", performanceMicros: "0"
    }]);
    expect(JSON.stringify(memberExport)).not.toMatch(/backup-hidden:[az]|protected-future-[az]|Águilas|Bears|Zebras|Yaks|Backup top-level post|Backup reply/);

    const objects: Array<{ key: string; value: string }> = [];
    const bucket = { put: async (objectKey: string, value: string) => { objects.push({ key: objectKey, value }); } } as unknown as R2Bucket;
    await backupPools({ db: bindings.DB, pools: bindings.POOL_DO, bucket, encryptionKey: key, backupServiceToken: bindings.POOL_BACKUP_SERVICE_TOKEN });
    expect(objects).toHaveLength(1);
    expect(objects[0]?.key).toMatch(new RegExp(`^${poolId}/audit-.*\\.json\\.aesgcm$`));
    const envelope = JSON.parse(objects[0]!.value) as { nonce: string; ciphertext: string };
    expect(envelope).toMatchObject({ format: "share-value-pool-backup-aes-gcm-v1", algorithm: "AES-GCM" });
    const cryptoKey = await crypto.subtle.importKey("raw", decodeBackupKey(key), { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(atob(envelope.nonce), (byte) => byte.charCodeAt(0)) }, cryptoKey, Uint8Array.from(atob(envelope.ciphertext), (byte) => byte.charCodeAt(0)));
    const backup = JSON.parse(new TextDecoder().decode(plaintext));
    expect(backup).toMatchObject({
      format: "share-value-pool-audit-v1", pool: { id: poolId },
      seasons: [expect.objectContaining({ id: "backup-season", rulesetVersion: "SHARE_POOL_BACKUP_V1" })],
      seasonProviderResults: [expect.objectContaining({ seasonId: "backup-season", eventId: "backup-super-bowl", appendOrder: "1", result: expect.objectContaining({ homeScore: 31, awayScore: 27 }) })]
    });
    expect(backup.wagerLegSnapshots).toEqual([
      { wagerLegId: "backup-hidden:a", homeTeam: "Águilas", awayTeam: "Bears" },
      { wagerLegId: "backup-hidden:z", homeTeam: "Zebras", awayTeam: "Yaks" }
    ]);
    expect(backup.messageBoardEntries).toEqual([
      { id: "backup-board-post", parent_post_id: null, author_id: "member", text: "Backup top-level post", created_at: "2026-01-03T00:00:00.000Z", activity_at: "2026-01-03T00:00:01.000Z", is_announcement: 1 },
      { id: "backup-board-reply", parent_post_id: "backup-board-post", author_id: "viewer", text: "Backup reply", created_at: "2026-01-03T00:00:01.000Z", activity_at: "2026-01-03T00:00:01.000Z", is_announcement: 0 }
    ]);
    expect(backup.messageBoardReadStates).toEqual([
      { member_id: "member", last_read_at: "2026-01-03T00:00:01.000Z" },
      { member_id: "viewer", last_read_at: "2026-01-03T00:00:00.000Z" }
    ]);
  }, 90_000);

  it("fails closed without storing a backup when an accepted wager leg is missing its team snapshot", async () => {
    const poolId = `missing-snapshot-${crypto.randomUUID()}`;
    await pool(poolId, "missing-snapshot-pool");
    await stateFor(poolId, (state) => state.storage.sql.exec(`
      INSERT INTO season (id, label, ruleset_version, state, created_at, opened_at, closed_at, close_reason, float_micros, notional_micros, default_mode, default_amount_micros, command_version) VALUES ('corrupt-season', 'Corrupt Season', 'SHARE_POOL_CORRUPT_V1', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL, '0', '0', NULL, NULL, '2');
      INSERT INTO wager VALUES ('corrupt-wager', 'corrupt-season', 'member', 'straight', '1000000', -110, 'open', 'SHARE_POOL_CORRUPT_V1', NULL, '2026-01-02T00:00:00.000Z');
      INSERT INTO wager_leg VALUES ('missing-snapshot-leg', 'corrupt-wager', 'missing-snapshot-event', 'nfl', 'DraftKings', '2026-01-02T00:00:00.000Z', 'policy', 'offer', NULL, NULL, 'spread', 'home', '-2.5', -110, NULL, NULL, '2099-01-02T00:00:00.000Z', 0, NULL, NULL);
    `));

    const memberResponse = await createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => ({ id: "viewer", name: "Viewer" }) }).fetch(new Request("https://pool.example.test/api/p/missing-snapshot-pool/export"));
    expect(memberResponse.status).toBe(200);
    expect(JSON.stringify(await memberResponse.json())).not.toMatch(/missing-snapshot-leg|missing-snapshot-event/);
    const infrastructureResponse = await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.internal/internal/audit-export", { headers: { "x-backup-service-token": bindings.POOL_BACKUP_SERVICE_TOKEN } });
    expect(infrastructureResponse.status).toBe(500);
    expect(await infrastructureResponse.text()).toBe("Internal Server Error");

    expect((await bindings.BACKUPS.list({ prefix: `${poolId}/` })).objects).toEqual([]);
    expect(await backupPools({ db: bindings.DB, pools: bindings.POOL_DO, bucket: bindings.BACKUPS, encryptionKey: key, backupServiceToken: bindings.POOL_BACKUP_SERVICE_TOKEN })).toEqual({ attempted: 1, stored: 0 });
    expect((await bindings.BACKUPS.list({ prefix: `${poolId}/` })).objects).toEqual([]);
  }, 90_000);

  it("fails closed without storing a backup when a team snapshot has no wager leg", async () => {
    const poolId = `orphan-snapshot-${crypto.randomUUID()}`;
    await pool(poolId, "orphan-snapshot-pool");
    await stateFor(poolId, (state) => state.storage.sql.exec("INSERT INTO wager_leg_snapshot VALUES ('orphan-snapshot-leg', 'Secret Home', 'Secret Away')"));

    const memberResponse = await createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => ({ id: "viewer", name: "Viewer" }) }).fetch(new Request("https://pool.example.test/api/p/orphan-snapshot-pool/export"));
    expect(memberResponse.status).toBe(200);
    expect(JSON.stringify(await memberResponse.json())).not.toMatch(/orphan-snapshot-leg|Secret Home|Secret Away/);
    const infrastructureResponse = await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.internal/internal/audit-export", { headers: { "x-backup-service-token": bindings.POOL_BACKUP_SERVICE_TOKEN } });
    expect(infrastructureResponse.status).toBe(500);
    expect(await infrastructureResponse.text()).toBe("Internal Server Error");

    expect((await bindings.BACKUPS.list({ prefix: `${poolId}/` })).objects).toEqual([]);
    expect(await backupPools({ db: bindings.DB, pools: bindings.POOL_DO, bucket: bindings.BACKUPS, encryptionKey: key, backupServiceToken: bindings.POOL_BACKUP_SERVICE_TOKEN })).toEqual({ attempted: 1, stored: 0 });
    expect((await bindings.BACKUPS.list({ prefix: `${poolId}/` })).objects).toEqual([]);
  }, 90_000);

  it("rotates a bounded cursor across more than 100 pools, failures, wraparound, and a deleted target", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `cursor-${String(index).padStart(3, "0")}`);
    for (const poolId of ids) await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, poolId, poolId, `create-${poolId}`, new Date().toISOString()).run();
    const attempted: string[] = [];
    const pools = {
      idFromName: (name: string) => name,
      get: (id: string) => ({ fetch: async () => { attempted.push(id); return id === "cursor-050" ? new Response("failed", { status: 500 }) : Response.json({ pool: id }); } })
    } as unknown as DurableObjectNamespace;
    const bucket = { put: async () => undefined } as unknown as R2Bucket;
    const deps = { db: bindings.DB, pools, bucket, encryptionKey: key, backupServiceToken: "local-token" };
    expect(await backupPools(deps)).toEqual({ attempted: 100, stored: 99 });
    expect(attempted).toEqual(ids.slice(0, 100));
    expect(await backupPools(deps)).toEqual({ attempted: 1, stored: 1 });
    expect(await backupPools(deps)).toEqual({ attempted: 100, stored: 99 });
    await bindings.DB.prepare("DELETE FROM pool_registry WHERE pool_id = 'cursor-099'").run();
    expect(await backupPools(deps)).toEqual({ attempted: 1, stored: 1 });
    expect(attempted.slice(-1)).toEqual(["cursor-100"]);
  }, 90_000);
});
