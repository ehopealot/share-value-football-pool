import { authenticatePoolSecret } from "../security/pool-password";
import type { InitializePoolInput, PoolCommandClient } from "./pool-command-client";

export interface RegistryRecord {
  poolId: string;
  slug: string;
  creatorId: string;
  commandId: string;
  commandVersion: string;
  status: "initializing" | "ready" | "failed";
  lastError?: string;
}

export type CreatePoolInput = {
  slug: string;
  creatorId: string;
  idempotencyKey: string;
  creatorName?: string;
  poolName?: string;
  password?: string;
};
type RegistryRow = { pool_id: string; normalized_slug: string; creator_id: string; command_id: string; status: RegistryRecord["status"]; last_error: string | null };
type ResponseRow = { normalized_slug: string; creator_id: string; initialization_fingerprint: string; response_json: string };

const initializationFingerprint = (input: Required<CreatePoolInput>, authenticatorKey: string) =>
  authenticatePoolSecret(JSON.stringify({ slug: normalizeSlug(input.slug), creatorId: input.creatorId, creatorName: input.creatorName, poolName: input.poolName, password: input.password }), input.idempotencyKey, authenticatorKey);

const requireInitialization = (input: CreatePoolInput): Required<CreatePoolInput> => {
  if (!input.creatorName || !input.poolName || !input.password) throw new Error("INITIALIZATION_MATERIAL_REQUIRED");
  return input as Required<CreatePoolInput>;
};

const normalizeSlug = (slug: string) => {
  const normalized = slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) throw new Error("Pool slug must be lowercase URL-safe words.");
  return normalized;
};
const toRecord = (row: RegistryRow, commandVersion = "0"): RegistryRecord => ({ poolId: row.pool_id, slug: row.normalized_slug, creatorId: row.creator_id, commandId: row.command_id, commandVersion, status: row.status, ...(row.last_error ? { lastError: row.last_error } : {}) });
const initialization = (record: RegistryRecord, input: CreatePoolInput | undefined): InitializePoolInput => {
  if (!input?.password || !input.creatorName || !input.poolName) throw new Error("INITIALIZATION_MATERIAL_UNAVAILABLE");
  return { poolId: record.poolId, slug: record.slug, creatorId: record.creatorId, commandId: record.commandId, creatorName: input.creatorName, poolName: input.poolName, password: input.password };
};

/**
 * D1 handles slug reservation and creation responses; PoolDO owns member
 * authorization, authoritative state, and each command's replay policy.
 */
export class PoolRegistry {
  constructor(private readonly db: D1Database, private readonly commands: PoolCommandClient, private readonly commandAuthenticatorKey?: string) {}

  async create(input: CreatePoolInput): Promise<RegistryRecord> {
    const completeInput = requireInitialization(input);
    if (!this.commandAuthenticatorKey) throw new Error("COMMAND_AUTHENTICATOR_UNAVAILABLE");
    const slug = normalizeSlug(completeInput.slug);
    const fingerprint = initializationFingerprint(completeInput, this.commandAuthenticatorKey);
    const replay = await this.db.prepare("SELECT normalized_slug, creator_id, initialization_fingerprint, response_json FROM pool_registry_command_response WHERE command_id = ?").bind(completeInput.idempotencyKey).first<ResponseRow>();
    if (replay) {
      if (replay.normalized_slug !== slug || replay.creator_id !== completeInput.creatorId || replay.initialization_fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
      return JSON.parse(replay.response_json) as RegistryRecord;
    }
    const poolId = crypto.randomUUID();
    const reserved: RegistryRecord = { poolId, slug, creatorId: completeInput.creatorId, commandId: completeInput.idempotencyKey, commandVersion: "0", status: "initializing" };
    try {
      await this.db.batch([
        this.db.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, ?, 'initializing', ?, ?)").bind(poolId, slug, poolId, completeInput.creatorId, completeInput.idempotencyKey, new Date().toISOString()),
        this.db.prepare("INSERT INTO pool_registry_command_response (command_id, normalized_slug, creator_id, initialization_fingerprint, response_json, command_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(completeInput.idempotencyKey, slug, completeInput.creatorId, fingerprint, JSON.stringify(reserved), "0", new Date().toISOString())
      ]);
    } catch {
      const reservedRow = await this.db.prepare("SELECT pool_id, normalized_slug, creator_id, command_id, status, last_error FROM pool_registry WHERE command_id = ?").bind(completeInput.idempotencyKey).first<RegistryRow>();
      if (!reservedRow) throw new Error("Pool slug is already reserved.");
      const existingResponse = await this.db.prepare("SELECT normalized_slug, creator_id, initialization_fingerprint, response_json FROM pool_registry_command_response WHERE command_id = ?").bind(completeInput.idempotencyKey).first<ResponseRow>();
      if (reservedRow.normalized_slug !== slug || reservedRow.creator_id !== completeInput.creatorId || !existingResponse || existingResponse.initialization_fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
      const existing = toRecord(reservedRow);
      if (existing.status === "ready" || existing.status === "failed") return existing;
      return this.finish(existing, completeInput);
    }
    return this.finish(reserved, completeInput);
  }

  async getBySlug(slug: string): Promise<RegistryRecord | undefined> {
    const row = await this.db.prepare("SELECT pool_id, normalized_slug, creator_id, command_id, status, last_error FROM pool_registry WHERE normalized_slug = ?").bind(normalizeSlug(slug)).first<RegistryRow>();
    return row ? toRecord(row) : undefined;
  }

  async repair(slug: string, input?: CreatePoolInput): Promise<RegistryRecord> {
    const record = await this.getBySlug(slug);
    if (!record) throw new Error("Pool registry record was not found.");
    if (input) {
      const completeInput = requireInitialization(input);
      if (!this.commandAuthenticatorKey || normalizeSlug(completeInput.slug) !== record.slug || completeInput.creatorId !== record.creatorId || completeInput.idempotencyKey !== record.commandId) throw new Error("IDEMPOTENCY_CONFLICT");
      const response = await this.db.prepare("SELECT initialization_fingerprint FROM pool_registry_command_response WHERE command_id = ?").bind(record.commandId).first<Pick<ResponseRow, "initialization_fingerprint">>();
      if (!response || response.initialization_fingerprint !== initializationFingerprint(completeInput, this.commandAuthenticatorKey)) throw new Error("IDEMPOTENCY_CONFLICT");
      input = completeInput;
    }
    await this.db.prepare("UPDATE pool_registry SET status = 'initializing', last_error = NULL WHERE pool_id = ?").bind(record.poolId).run();
    return this.finish({ ...record, status: "initializing" }, input);
  }

  private async finish(record: RegistryRecord, input?: CreatePoolInput): Promise<RegistryRecord> {
    try {
      const response = await this.commands.initializePool(initialization(record, input));
      const ready = { ...record, commandVersion: response.commandVersion, status: "ready" as const };
      await this.db.prepare("UPDATE pool_registry SET status = 'ready', last_error = NULL WHERE pool_id = ?").bind(record.poolId).run();
      await this.persistResponse(ready);
      return ready;
    } catch (error) {
      const failed = { ...record, status: "failed" as const, lastError: error instanceof Error ? error.message : "Pool initialization failed." };
      await this.db.prepare("UPDATE pool_registry SET status = 'failed', last_error = ? WHERE pool_id = ?").bind(failed.lastError, record.poolId).run();
      await this.persistResponse(failed);
      return failed;
    }
  }

  private async persistResponse(record: RegistryRecord): Promise<void> {
    await this.db.prepare("UPDATE pool_registry_command_response SET response_json = ?, command_version = ? WHERE command_id = ? AND json_extract(response_json, '$.status') = 'initializing'").bind(JSON.stringify(record), record.commandVersion, record.commandId).run();
  }
}
