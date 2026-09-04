import { migratePoolStorage, migrateSeasonCreatedAt, poolSchema } from "./schema";
import { authenticatePoolSecret, hashPoolPassword, verifyPoolPassword } from "../security/pool-password";
import { executeShareOrder, quoteShareOrder, reverseShareOrder } from "./accounting-commands";
import { divideRoundHalfEven, MICROS_PER_UNIT, parseIntegerText } from "../domain/fixed-point";
import { validateTeaser } from "../domain/grading";
import type { TeaserLeg } from "../domain/types";
import { OrderQuoteStaleError } from "./accounting-repository";
import { poolCommandSchema, type PoolCommand, type PoolCommandResult } from "./pool-commands";
import { placeWager, SideBetLimitError } from "./wager-commands";
import { runSettlementAlarm } from "./alarm";
import { correctWager, voidWager } from "./settlement";
import { enqueueOutbox, drainOutbox, nextOutboxAttempt, type PoolOutboxMessage } from "./outbox";
import { shapeWagers } from "./views";
import { infrastructureAuditExport, memberAuditExport } from "../services/audit-export";
import { TEASER_RULESET_ID } from "../domain/teaser-table";
import { parlayOdds } from "../domain/parlay";

/**
 * Grace only covers post-command drain scheduling. Vitest compiles it far-future,
 * but alarm() can re-arm lifecycle/retry deadlines; tests driving due non-terminal
 * alarms must use far-future fixtures or state.storage.deleteAlarm() afterwards.
 */
const configuredDrainGraceMs = (globalThis as Record<string, unknown>).POOL_OUTBOX_DRAIN_GRACE_MS;
const outboxDrainGraceMs = typeof configuredDrainGraceMs === "number" && Number.isInteger(configuredDrainGraceMs) && Number.isFinite(configuredDrainGraceMs) && configuredDrainGraceMs >= 1_000 && configuredDrainGraceMs <= 31_536_000_000 ? configuredDrainGraceMs : 1_000;

type Row = Record<string, SqlStorageValue>;
const first = (sql: SqlStorage, query: string, ...params: SqlStorageValue[]): Row | undefined => [...sql.exec<Row>(query, ...params)][0];
const now = () => new Date().toISOString();
const actorId = (command: PoolCommand) => command.type === "InitializePool" ? command.creatorId : command.actorId;
const isReadCommand = (command: PoolCommand) => command.type === "ReadPoolGate" || command.type === "ReadPoolView" || command.type === "ReadMessageBoard" || command.type === "ReadStandings" || command.type === "ReadActivity" || command.type === "ReadSeasonHistory" || command.type === "ReadWagers" || command.type === "ReadMyWagers" || command.type === "ReadAuditExport" || command.type === "ProbePlacementReplay" || command.type === "ReplayWagerQuote";
const isQuoteCommand = (command: PoolCommand) => command.type === "QuoteShareOrder" || command.type === "QuoteStraightWager" || command.type === "QuoteTeaserWager" || command.type === "QuoteParlayWager";
/** A standalone commissioner notice is informational and must not affect wagering or projections. */
const isNoticeOnlySettingsCommand = (command: PoolCommand) => command.type === "UpdatePoolSettings" && command.commissionerNotice !== undefined && command.poolName === undefined && command.password === undefined && command.signupsOpen === undefined && command.maxSideBetMicros === undefined;
/** Board conversation and standalone commissioner notices are authoritative-only, without D1 projection or alarm work. */
const shouldEnqueueOutbox = (command: PoolCommand) => !isReadCommand(command) && !isQuoteCommand(command) && command.type !== "CreateMessageBoardPost" && command.type !== "ReplyToMessageBoardPost" && !isNoticeOnlySettingsCommand(command);
const canonical = (value: unknown) => JSON.stringify(value);
/** The durable quote binding intentionally excludes snapshot and envelope metadata. */
const placementTerms = (value: { wagerId: string; quoteKey: string; seasonId: string; riskMicros: string; acceptedOdds: number; rulesetVersion: string; leg?: unknown; teaserPoints?: number; legs?: unknown }) => value.leg !== undefined
  ? { wagerId: value.wagerId, quoteKey: value.quoteKey, seasonId: value.seasonId, riskMicros: value.riskMicros, acceptedOdds: value.acceptedOdds, rulesetVersion: value.rulesetVersion, leg: value.leg }
  : { wagerId: value.wagerId, quoteKey: value.quoteKey, seasonId: value.seasonId, riskMicros: value.riskMicros, acceptedOdds: value.acceptedOdds, teaserPoints: value.teaserPoints, rulesetVersion: value.rulesetVersion, legs: value.legs };
const requestFingerprint = (command: PoolCommand, commandAuthenticatorKey?: string) => {
  const authenticate = (password: string) => {
    if (!commandAuthenticatorKey) throw new Error("POOL_NOT_INITIALIZED");
    return authenticatePoolSecret(password, command.commandId, commandAuthenticatorKey);
  };
  if (command.type === "InitializePool" || command.type === "JoinPool") return canonical({ ...command, password: authenticate(command.password) });
  if (command.type === "UpdatePoolSettings" && command.password !== undefined) return canonical({ ...command, password: authenticate(command.password) });
  // Browser quote retries must survive mutable D1 offers, while reuse for a different browser request remains a conflict.
  if (command.type === "QuoteStraightWager" || command.type === "QuoteTeaserWager" || command.type === "QuoteParlayWager") return canonical({ type: command.type, commandId: command.commandId, actorId: command.actorId, identity: command.identity });
  return canonical(command);
};
/** Pre-announcement post commands remain replayable for the processed-command retention window. */
const legacyPostRequestFingerprint = (command: Extract<PoolCommand, { type: "CreateMessageBoardPost" }>) => {
  const { announcement: _announcement, ...legacy } = command;
  return canonical(legacy);
};

/**
 * The sole authoritative, serialized state machine for one pool. D1 records
 * are repairable discovery projections and are never read here.
 */
export class PoolDO {
  constructor(protected readonly state: DurableObjectState, protected readonly env: { POOL_COMMAND_AUTHENTICATOR_KEY?: string; SETTLEMENT_SERVICE_TOKEN?: string; POOL_PROJECTION_SERVICE_TOKEN?: string; POOL_BACKUP_SERVICE_TOKEN?: string; DB?: D1Database; POOL_EVENTS?: Queue<import("./outbox").PoolOutboxMessage> }) {
    for (const statement of poolSchema) this.state.storage.sql.exec(statement);
    this.state.storage.transactionSync(() => {
      migrateSeasonCreatedAt(this.state.storage.sql);
      migratePoolStorage(this.state.storage.sql);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/internal/projection") {
      if (request.method !== "GET" || !this.env.POOL_PROJECTION_SERVICE_TOKEN || request.headers.get("x-projection-service-token") !== this.env.POOL_PROJECTION_SERVICE_TOKEN) return new Response("Not found", { status: 404 });
      return Response.json(this.projectionSnapshot(this.state.storage.sql));
    }
    if (new URL(request.url).pathname === "/internal/audit-export") {
      if (request.method !== "GET" || !this.env.POOL_BACKUP_SERVICE_TOKEN || request.headers.get("x-backup-service-token") !== this.env.POOL_BACKUP_SERVICE_TOKEN) return new Response("Not found", { status: 404 });
      try {
        return Response.json(infrastructureAuditExport(this.state.storage.sql));
      } catch {
        return new Response("Internal Server Error", { status: 500 });
      }
    }
    if (new URL(request.url).pathname === "/internal/settle") {
      if (request.method !== "POST" || !this.env.SETTLEMENT_SERVICE_TOKEN || request.headers.get("x-settlement-service-token") !== this.env.SETTLEMENT_SERVICE_TOKEN) return new Response("Not found", { status: 404 });
      await this.alarm();
      return Response.json({ ok: true });
    }
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    try {
      const parsed = poolCommandSchema.safeParse(await request.json());
      if (!parsed.success) throw new Error("INVALID_COMMAND");
      const result = await this.state.storage.transaction(async () => this.execute(parsed.data));
      // Defer post-commit outbox draining very briefly so a request cannot race its own alarm; settlement then replaces this with the earliest lifecycle deadline.
      if (shouldEnqueueOutbox(parsed.data)) await this.state.storage.setAlarm(Date.now() + outboxDrainGraceMs);
      return Response.json(result);
    } catch (error) {
      if (error instanceof SideBetLimitError) return Response.json({ code: error.message, ...error.details }, { status: 400 });
      if (error instanceof OrderQuoteStaleError) {
        return Response.json({ code: error.message, priceMicros: error.quote.priceMicros.toString(), commandVersion: error.quote.commandVersion, replacement: { ...error.terms, priceMicros: error.quote.priceMicros.toString(), commandVersion: error.quote.commandVersion, sharesMicros: error.quote.sharesMicros.toString(), valueMicros: error.quote.valueMicros.toString() } }, { status: 400 });
      }
      return Response.json({ code: error instanceof Error ? error.message : "COMMAND_FAILED" }, { status: 400 });
    }
  }

  protected execute(command: PoolCommand): PoolCommandResult {
    const sql = this.state.storage.sql;
    const commandAuthenticatorKey = this.env.POOL_COMMAND_AUTHENTICATOR_KEY;
    if (!commandAuthenticatorKey) throw new Error("COMMAND_AUTHENTICATOR_UNAVAILABLE");
    const previous = first(sql, "SELECT type, actor_id, request_json, response_json FROM processed_command WHERE id = ?", command.commandId);
    // Reads are authorization-sensitive snapshots and are intentionally never replayed from processed_command.
    const isRead = isReadCommand(command);
    if (previous && !isRead) {
      const legacyPostReplay = command.type === "CreateMessageBoardPost" && !command.announcement && previous.request_json === legacyPostRequestFingerprint(command);
      if (previous.type !== command.type || previous.actor_id !== actorId(command) || (previous.request_json !== requestFingerprint(command, commandAuthenticatorKey) && !legacyPostReplay)) throw new Error("IDEMPOTENCY_CONFLICT");
      const response = JSON.parse(String(previous.response_json)) as Record<string, unknown>;
      // External notifications need to distinguish newly committed actions from idempotent replays.
      if (command.type === "CreateMessageBoardPost") return { ...response, ...(typeof response.postId === "string" ? {} : { isAnnouncement: false }), replayed: true } as unknown as PoolCommandResult;
      return (command.type === "JoinPool" || command.type === "ExecuteShareOrder" ? { ...response, replayed: true } : response) as PoolCommandResult;
    }

    let result: PoolCommandResult;
    if (command.type === "InitializePool") result = this.initialize(sql, command);
    else result = this.authorized(sql, command);
    if (shouldEnqueueOutbox(command)) {
      enqueueOutbox(sql, this.commandOutboxEvent(sql, command, result.commandVersion));
      if (command.type === "CloseSeason") {
        sql.exec("UPDATE season SET command_version = ? WHERE id = ?", result.commandVersion, command.seasonId);
        enqueueOutbox(sql, { eventId: crypto.randomUUID(), eventType: "SeasonClosed", version: result.commandVersion, payload: { poolId: String(first(sql, "SELECT id FROM pool LIMIT 1")!.id), seasonId: command.seasonId, closeReason: "commissioner_closed" } });
      }
    }
    if (!isRead) sql.exec(
      "INSERT INTO processed_command (id, type, actor_id, request_json, response_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      command.commandId, command.type, actorId(command), requestFingerprint(command, commandAuthenticatorKey), canonical(result), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    );
    sql.exec("DELETE FROM processed_command WHERE expires_at < ?", now());
    return result;
  }

  private commandOutboxEvent(sql: SqlStorage, command: PoolCommand, version: string): PoolOutboxMessage {
    const base = { poolId: String(first(sql, "SELECT id FROM pool LIMIT 1")!.id), actorId: actorId(command), commandId: command.commandId };
    let payload: Extract<PoolOutboxMessage, { eventType: "CommandApplied" }>['payload'];
    switch (command.type) {
      case "InitializePool": payload = { ...base, commandType: command.type, memberId: command.creatorId }; break;
      case "JoinPool": payload = { ...base, commandType: command.type, memberId: command.actorId }; break;
      case "UpdateMemberNickname": payload = { ...base, commandType: command.type, memberId: command.actorId }; break;
      case "UpdatePoolSettings": payload = { ...base, commandType: command.type }; break;
      case "CreateSeason":
      case "OpenSeason":
      case "CloseSeason":
      case "ConfirmSuperBowl": payload = { ...base, commandType: command.type, seasonId: command.seasonId }; break;
      case "ExecuteShareOrder": {
        const order = first(sql, "SELECT id FROM share_order WHERE command_id = ?", command.commandId);
        if (!order) throw new Error("OUTBOX_IDENTITY_MISSING");
        payload = { ...base, commandType: command.type, seasonId: command.seasonId, memberId: command.memberId, orderId: String(order.id) };
        break;
      }
      case "ReverseShareOrder": {
        const order = first(sql, "SELECT season_id, member_id FROM share_order WHERE id = ?", command.orderId);
        if (!order) throw new Error("OUTBOX_IDENTITY_MISSING");
        payload = { ...base, commandType: command.type, seasonId: String(order.season_id), memberId: String(order.member_id), orderId: command.orderId };
        break;
      }
      case "SuspendMember":
      case "RestoreMember":
      case "TransferCommissioner": payload = { ...base, commandType: command.type, memberId: command.memberId }; break;
      case "VoidWager":
      case "RegradeWager": payload = { ...base, commandType: command.type, wagerId: command.wagerId }; break;
      case "CreateSeasonAnnotation": payload = { ...base, commandType: command.type, seasonId: command.seasonId }; break;
      case "PlaceStraightWager":
      case "PlaceTeaserWager":
      case "PlaceParlayWager": payload = { ...base, commandType: command.type, seasonId: command.seasonId, memberId: command.actorId, wagerId: command.wagerId }; break;
      default: throw new Error("OUTBOX_IDENTITY_MISSING");
    }
    return { eventId: crypto.randomUUID(), eventType: "CommandApplied", version, payload };
  }

  private initialize(sql: SqlStorage, command: Extract<PoolCommand, { type: "InitializePool" }>): PoolCommandResult {
    const existing = first(sql, "SELECT id FROM pool LIMIT 1");
    if (existing) throw new Error("POOL_ALREADY_INITIALIZED");
    const version = "1";
    sql.exec(
      "INSERT INTO pool (id, slug, name, commissioner_id, password_hash, password_version, signups_open, command_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      command.poolId, command.slug, command.poolName, command.creatorId, hashPoolPassword(command.password), 1, 1, version
    );
    sql.exec("INSERT INTO member (user_id, display_name, role, status, joined_at) VALUES (?, ?, 'commissioner', 'active', ?)", command.creatorId, command.creatorName, now());
    return { commandVersion: version, status: "ready" };
  }

  private authorized(sql: SqlStorage, command: Exclude<PoolCommand, { type: "InitializePool" }>): PoolCommandResult {
    const pool = first(sql, "SELECT commissioner_id, password_hash, signups_open, max_side_bet_micros, commissioner_notice, command_version, active_season_id FROM pool LIMIT 1");
    if (!pool) throw new Error("POOL_NOT_INITIALIZED");
    const member = first(sql, "SELECT role, status FROM member WHERE user_id = ?", command.actorId);
    if (member?.status === "suspended") throw new Error("SUSPENDED");

    if (command.type === "JoinPool") {
      if (!pool.signups_open || !verifyPoolPassword(command.password, String(pool.password_hash))) throw new Error("JOIN_DENIED");
      if (!member) {
        sql.exec("INSERT INTO member (user_id, display_name, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)", command.actorId, command.displayName, now());
        for (const season of sql.exec<Row>("SELECT id FROM season WHERE state IN ('draft', 'active')")) {
          sql.exec("INSERT INTO share_account (season_id, member_id, available_micros, locked_micros, row_version) VALUES (?, ?, '0', '0', '0')", season.id, command.actorId);
        }
        return { commandVersion: this.bumpVersion(sql), joined: true };
      }
      return { commandVersion: String(pool.command_version), joined: false };
    }

    if (command.type === "ReadPoolGate") {
      // Closed pools disclose no pool data to a nonmember; open pools disclose only their join label.
      if (!member) return pool.signups_open
        ? { membership: "joinable", poolName: String(first(sql, "SELECT name FROM pool LIMIT 1")!.name), signupsOpen: true } as unknown as PoolCommandResult
        : { membership: "closed", signupsOpen: false } as unknown as PoolCommandResult;
      if (member.status !== "active") throw new Error("SUSPENDED");
      return { commandVersion: String(pool.command_version), membership: "member" };
    }
    if (!member || member.status !== "active") throw new Error("FORBIDDEN");
    if (command.type === "ReadPoolView") return this.readPool(sql, command.actorId, String(pool.command_version), pool.active_season_id);
    if (command.type === "ReadMessageBoard") return this.readMessageBoard(sql, command.actorId, String(pool.command_version), String(pool.commissioner_id) === command.actorId && member.role === "commissioner");
    if (command.type === "CreateMessageBoardPost") {
      if (command.announcement && (String(pool.commissioner_id) !== command.actorId || member.role !== "commissioner")) throw new Error("FORBIDDEN");
      return this.createMessageBoardPost(sql, command);
    }
    if (command.type === "ReplyToMessageBoardPost") return this.replyToMessageBoardPost(sql, command);
    if (command.type === "ReadStandings") return { commandVersion: String(pool.command_version), standings: this.standings(sql, pool.active_season_id) };
    if (command.type === "ReadActivity") return { commandVersion: String(pool.command_version), activity: this.activity(sql, command.actorId) };
    if (command.type === "ReadSeasonHistory") return { commandVersion: String(pool.command_version), ...this.history(sql, command.seasonId, command.actorId) };
    if (command.type === "ReadWagers") return { commandVersion: String(pool.command_version), ...shapeWagers(sql, command.actorId, this.authoritativeTime()) };
    if (command.type === "ReadMyWagers") return { commandVersion: String(pool.command_version), ...shapeWagers(sql, command.actorId, this.authoritativeTime(), true) };
    if (command.type === "ReadAuditExport") return { commandVersion: String(pool.command_version), ...memberAuditExport(sql, command.actorId, this.authoritativeTime()) };
    if (command.type === "ProbePlacementReplay") {
      const candidate = poolCommandSchema.safeParse(command.placement);
      if (!candidate.success || (candidate.data.type !== "PlaceStraightWager" && candidate.data.type !== "PlaceTeaserWager" && candidate.data.type !== "PlaceParlayWager") || candidate.data.actorId !== command.actorId) throw new Error("INVALID_PLACEMENT_REPLAY_PROBE");
      const previousPlacement = first(sql, "SELECT type, actor_id, request_json, response_json FROM processed_command WHERE id = ?", candidate.data.commandId);
      if (!previousPlacement) return { commandVersion: String(pool.command_version), replayed: false };
      if (previousPlacement.type !== candidate.data.type || previousPlacement.actor_id !== candidate.data.actorId || previousPlacement.request_json !== requestFingerprint(candidate.data, this.env.POOL_COMMAND_AUTHENTICATOR_KEY)) throw new Error("IDEMPOTENCY_CONFLICT");
      return { commandVersion: String(pool.command_version), replayed: true, response: JSON.parse(String(previousPlacement.response_json)) };
    }
    if (command.type === "ReplayWagerQuote") {
      if (command.identity.actorId !== command.actorId || command.identity.quoteKey !== command.commandId) throw new Error("INVALID_QUOTE");
      const stored = first(sql, "SELECT fingerprint, snapshot_json FROM wager_quote WHERE actor_id = ? AND quote_key = ?", command.actorId, command.commandId);
      if (!stored) throw new Error("QUOTE_NOT_FOUND");
      if (stored.fingerprint !== command.identity.fingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
      return JSON.parse(String(stored.snapshot_json)) as PoolCommandResult;
    }
    if (command.type === "QuoteStraightWager" || command.type === "QuoteTeaserWager" || command.type === "QuoteParlayWager") {
      if (command.identity.actorId !== command.actorId || command.identity.quoteKey !== command.commandId || command.projection.actorId !== command.actorId || command.projection.quoteKey !== command.commandId || command.projection.fingerprint !== command.identity.fingerprint) throw new Error("INVALID_QUOTE");
      const existing = first(sql, "SELECT fingerprint, wager_id, kind, snapshot_json FROM wager_quote WHERE actor_id = ? AND quote_key = ?", command.actorId, command.commandId);
      const kind = command.type === "QuoteStraightWager" ? "straight" : command.type === "QuoteTeaserWager" ? "teaser" : "parlay";
      if (existing) {
        if (existing.fingerprint !== command.identity.fingerprint || existing.wager_id !== command.projection.wagerId || existing.kind !== kind) throw new Error("IDEMPOTENCY_CONFLICT");
        return JSON.parse(String(existing.snapshot_json)) as PoolCommandResult;
      }
      const commandVersion = String(pool.command_version);
      if (command.type === "QuoteTeaserWager") {
        if (command.projection.legs.length > 6) throw new Error("INVALID_QUOTE");
        try {
          validateTeaser(command.projection.legs.map((leg) => ({ eventId: leg.eventId, market: leg.market, selection: leg.selection, line: leg.originalLine } as TeaserLeg)), command.projection.teaserPoints);
        } catch {
          throw new Error("INVALID_QUOTE");
        }
      }
      if (command.type === "QuoteParlayWager" && parlayOdds(command.projection.legs) !== command.projection.acceptedOdds) throw new Error("INVALID_QUOTE");
      const { wagerId: quotedWagerId, actorId: _actor, fingerprint: _fingerprint, ...snapshot } = command.projection;
      if (snapshot.ownerMemberId !== command.actorId || snapshot.commandVersion !== commandVersion) throw new Error("ORDER_QUOTE_STALE");
      const terms = placementTerms({ wagerId: quotedWagerId, ...snapshot });
      sql.exec("INSERT INTO wager_quote (actor_id, quote_key, fingerprint, wager_id, kind, terms_json, command_version, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", command.actorId, command.commandId, command.identity.fingerprint, quotedWagerId, kind, canonical(terms), commandVersion, canonical(snapshot), now());
      return snapshot;
    }
    if (command.type === "PlaceStraightWager" || command.type === "PlaceTeaserWager" || command.type === "PlaceParlayWager") {
      if (command.type === "PlaceTeaserWager" && command.legs.length > 6) throw new Error("INVALID_WAGER_LEG");
      const quote = first(sql, "SELECT wager_id, kind, terms_json, command_version FROM wager_quote WHERE actor_id = ? AND quote_key = ?", command.actorId, command.quoteKey);
      if (!quote) throw new Error("LINE_CHANGED");
      const kind = command.type === "PlaceStraightWager" ? "straight" : command.type === "PlaceTeaserWager" ? "teaser" : "parlay";
      if (quote.kind !== kind || String(quote.wager_id) !== command.wagerId) throw new Error("LINE_CHANGED");
      if (command.quotedCommandVersion !== String(quote.command_version)) throw new Error("ORDER_QUOTE_STALE");
      if (canonical(placementTerms(command)) !== String(quote.terms_json)) throw new Error("LINE_CHANGED");
      // Exact immutable terms can be atomically rebased onto current pool state; placeWager rechecks every mutable constraint.
      const result = placeWager(sql, command);
      return { ...result, commandVersion: this.bumpVersion(sql) };
    }
    if (command.type === "UpdateMemberNickname") {
      sql.exec("UPDATE member SET display_name = ? WHERE user_id = ?", command.displayName, command.actorId);
      return { commandVersion: this.bumpVersion(sql), displayName: command.displayName };
    }

    if (pool.commissioner_id !== command.actorId || member.role !== "commissioner") throw new Error("FORBIDDEN");

    if (command.type === "TransferCommissioner") {
      const target = first(sql, "SELECT status FROM member WHERE user_id = ?", command.memberId);
      if (!target) throw new Error("MEMBER_NOT_FOUND");
      if (target.status !== "active") throw new Error("SUSPENDED");
      if (command.memberId === String(pool.commissioner_id)) return { commandVersion: String(pool.command_version), transferred: false };
      sql.exec("UPDATE member SET role = CASE WHEN user_id = ? THEN 'commissioner' ELSE 'member' END", command.memberId);
      sql.exec("UPDATE pool SET commissioner_id = ?", command.memberId);
      sql.exec("INSERT INTO administration_audit (id, actor_id, action, subject_id, reason, command_id, created_at) VALUES (?, ?, 'transfer_commissioner', ?, ?, ?, ?)", crypto.randomUUID(), command.actorId, command.memberId, command.reason, command.commandId, now());
      return { commandVersion: this.bumpVersion(sql), transferred: true };
    }
    if (command.type === "CreateSeasonAnnotation") {
      const season = first(sql, "SELECT state FROM season WHERE id = ?", command.seasonId);
      if (!season) throw new Error("SEASON_NOT_FOUND");
      if (season.state !== "closed") throw new Error("SEASON_NOT_CLOSED");
      sql.exec("INSERT INTO season_annotation (id, season_id, actor_id, text, created_at) VALUES (?, ?, ?, ?, ?)", crypto.randomUUID(), command.seasonId, command.actorId, command.text, now());
      return { commandVersion: this.bumpVersion(sql) };
    }
    if (command.type === "VoidWager" || command.type === "RegradeWager") {
      const wager = first(sql, "SELECT wager.*, season.state AS season_state FROM wager JOIN season ON season.id = wager.season_id WHERE wager.id = ?", command.wagerId);
      if (!wager) throw new Error("WAGER_NOT_FOUND");
      if (wager.season_state !== "active") throw new Error("SEASON_NOT_ACTIVE");
      if (command.type === "RegradeWager") {
        const futureLeg = first(sql, "SELECT 1 FROM wager_leg WHERE wager_id = ? AND event_starts_at > ? LIMIT 1", command.wagerId, this.authoritativeTime().toISOString());
        if (futureLeg) throw new Error("WAGER_NOT_STARTED");
      }
      const closed = command.type === "VoidWager"
        ? voidWager(sql, wager, command.actorId, command.reason, command.commandId)
        : correctWager(sql, wager, command.actorId, command.reason, command.commandId, command.correctedResults);
      sql.exec("INSERT INTO administration_audit (id, actor_id, action, subject_id, reason, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", crypto.randomUUID(), command.actorId, command.type === "VoidWager" ? "void_wager" : "regrade_wager", command.wagerId, command.reason, command.commandId, now());
      const commandVersion = this.bumpVersion(sql);
      for (const season of closed) {
        sql.exec("UPDATE season SET command_version = ? WHERE id = ?", commandVersion, season.id);
        enqueueOutbox(sql, { eventId: crypto.randomUUID(), eventType: "SeasonClosed", version: commandVersion, payload: { poolId: String(first(sql, "SELECT id FROM pool LIMIT 1")!.id), seasonId: season.id, closeReason: season.reason } });
      }
      return { commandVersion };
    }

    if (command.type === "ConfirmSuperBowl") {
      const canonicalSuperBowl = first(sql, "SELECT season.state, season_super_bowl.event_id, season_super_bowl.event_starts_at FROM season LEFT JOIN season_super_bowl ON season_super_bowl.season_id = season.id WHERE season.id = ?", command.seasonId);
      if (!canonicalSuperBowl || canonicalSuperBowl.state !== "active") throw new Error("SEASON_NOT_ACTIVE");
      if (canonicalSuperBowl.event_id === null || String(canonicalSuperBowl.event_id) !== command.eventId) throw new Error("SUPER_BOWL_NOT_CANONICAL");
      const confirmedAt = now();
      sql.exec("UPDATE season_super_bowl SET confirmed_at = COALESCE(confirmed_at, ?) WHERE season_id = ?", confirmedAt, command.seasonId);
      // Confirmation, not a wager leg, arms bounded provider reconciliation for this season-level event.
      sql.exec("INSERT OR IGNORE INTO event_reconciliation (event_id, event_starts_at, phase, attempts, error_attempts, next_attempt_at) VALUES (?, ?, 'open', 0, 0, ?)", command.eventId, canonicalSuperBowl.event_starts_at ?? confirmedAt, confirmedAt);
      return { commandVersion: this.bumpVersion(sql) };
    }

    if (command.type === "UpdatePoolSettings") {
      if (command.poolName !== undefined && command.poolName.trim().length === 0) throw new Error("INVALID_POOL_NAME");
      const passwordHash = command.password === undefined ? pool.password_hash : hashPoolPassword(command.password);
      sql.exec("UPDATE pool SET name = ?, password_hash = ?, password_version = password_version + ?, signups_open = ?, max_side_bet_micros = ?, commissioner_notice = ?", command.poolName?.trim() || first(sql, "SELECT name FROM pool LIMIT 1")!.name, passwordHash, command.password === undefined ? 0 : 1, command.signupsOpen === undefined ? first(sql, "SELECT signups_open FROM pool LIMIT 1")!.signups_open : command.signupsOpen ? 1 : 0, command.maxSideBetMicros ?? String(pool.max_side_bet_micros), command.commissionerNotice === undefined ? pool.commissioner_notice ?? null : command.commissionerNotice);
      return { commandVersion: isNoticeOnlySettingsCommand(command) ? String(pool.command_version) : this.bumpVersion(sql) };
    }
    if (command.type === "CreateSeason") {
      if (first(sql, "SELECT id FROM season WHERE state IN ('draft', 'active')")) throw new Error("OVERLAPPING_SEASON");
      if (command.defaultOrder) {
        if (parseIntegerText(command.defaultOrder.amountMicros) <= 0n) throw new Error("INVALID_DEFAULT_ORDER");
      }
      sql.exec("INSERT INTO season (id, label, ruleset_version, state, created_at, float_micros, notional_micros, default_mode, default_amount_micros, command_version) VALUES (?, ?, ?, 'draft', ?, '0', '0', ?, ?, ?)", command.seasonId, command.label, TEASER_RULESET_ID, now(), command.defaultOrder?.mode ?? null, command.defaultOrder?.amountMicros ?? null, String(pool.command_version));
      for (const persistentMember of sql.exec<Row>("SELECT user_id FROM member")) {
        sql.exec("INSERT INTO share_account (season_id, member_id, available_micros, locked_micros, row_version) VALUES (?, ?, '0', '0', '0')", command.seasonId, persistentMember.user_id);
      }
      const commandVersion = this.bumpVersion(sql);
      sql.exec("UPDATE season SET command_version = ? WHERE id = ?", commandVersion, command.seasonId);
      return { commandVersion };
    }
    if (command.type === "OpenSeason") {
      const season = first(sql, "SELECT state FROM season WHERE id = ?", command.seasonId);
      if (!season || season.state !== "draft") throw new Error("SEASON_NOT_DRAFT");
      const openedAt = now();
      sql.exec("UPDATE season SET state = 'active', opened_at = ? WHERE id = ?", openedAt, command.seasonId);
      sql.exec("UPDATE pool SET active_season_id = ?", command.seasonId);
      sql.exec("INSERT OR IGNORE INTO season_super_bowl_reconciliation (season_id, attempts, error_attempts, next_attempt_at) VALUES (?, 0, 0, ?)", command.seasonId, openedAt);
      return { commandVersion: this.bumpVersion(sql) };
    }
    if (command.type === "CloseSeason") {
      const season = first(sql, "SELECT state FROM season WHERE id = ?", command.seasonId);
      if (!season || season.state !== "active") throw new Error("SEASON_NOT_ACTIVE");
      sql.exec("UPDATE season SET state = 'closed', closed_at = ?, close_reason = ? WHERE id = ?", now(), command.reason, command.seasonId);
      sql.exec("UPDATE pool SET active_season_id = NULL WHERE active_season_id = ?", command.seasonId);
      return { commandVersion: this.bumpVersion(sql) };
    }
    if (command.type === "QuoteShareOrder") {
      this.requireActiveMember(sql, command.memberId);
      return quoteShareOrder(sql as unknown as import("./accounting-repository").Sql, command.seasonId, command.memberId, command.mode, command.amountMicros);
    }
    if (command.type === "ExecuteShareOrder") {
      this.requireActiveMember(sql, command.memberId);
      const result = executeShareOrder(sql as unknown as import("./accounting-repository").Sql, command);
      return { ...result, commandVersion: this.bumpVersion(sql) };
    }
    if (command.type === "ReverseShareOrder") {
      const result = reverseShareOrder(sql as unknown as import("./accounting-repository").Sql, command);
      sql.exec("INSERT INTO administration_audit (id, actor_id, action, subject_id, reason, command_id, created_at) VALUES (?, ?, 'reverse_share_order', ?, ?, ?, ?)", crypto.randomUUID(), command.actorId, command.orderId, command.reason, command.commandId, now());
      return { ...result, commandVersion: this.bumpVersion(sql) };
    }
    if (command.type === "SuspendMember" || command.type === "RestoreMember") {
      const target = first(sql, "SELECT user_id FROM member WHERE user_id = ?", command.memberId);
      if (!target) throw new Error("MEMBER_NOT_FOUND");
      if (command.type === "SuspendMember" && command.memberId === String(pool.commissioner_id)) throw new Error("CANNOT_SUSPEND_COMMISSIONER");
      sql.exec("UPDATE member SET status = ? WHERE user_id = ?", command.type === "SuspendMember" ? "suspended" : "active", command.memberId);
      return { commandVersion: this.bumpVersion(sql) };
    }
    throw new Error("INVALID_COMMAND");
  }

  private readMessageBoard(sql: SqlStorage, actorId: string, commandVersion: string, canAnnounce: boolean): PoolCommandResult {
    const latest = first(sql, "SELECT activity_at FROM message_board_entry WHERE parent_post_id IS NULL ORDER BY activity_at DESC, id DESC LIMIT 1");
    if (latest?.activity_at !== null && latest?.activity_at !== undefined) this.advanceMessageBoardRead(sql, actorId, String(latest.activity_at));
    const threads = [...sql.exec<Row>("SELECT entry.id AS post_id, member.display_name AS author_display_name, entry.text, entry.created_at, entry.activity_at, entry.is_announcement FROM message_board_entry entry JOIN member ON member.user_id = entry.author_id WHERE entry.parent_post_id IS NULL ORDER BY entry.activity_at DESC, entry.created_at ASC, entry.id ASC")].map((post) => ({
      postId: String(post.post_id), authorDisplayName: String(post.author_display_name), text: String(post.text), createdAt: String(post.created_at), activityAt: String(post.activity_at), isAnnouncement: Boolean(post.is_announcement),
      replies: [...sql.exec<Row>("SELECT entry.id AS reply_id, member.display_name AS author_display_name, entry.text, entry.created_at FROM message_board_entry entry JOIN member ON member.user_id = entry.author_id WHERE entry.parent_post_id = ? ORDER BY entry.created_at ASC, entry.id ASC", post.post_id)].map((reply) => ({ replyId: String(reply.reply_id), authorDisplayName: String(reply.author_display_name), text: String(reply.text), createdAt: String(reply.created_at) }))
    }));
    return { commandVersion, canAnnounce, threads };
  }

  private createMessageBoardPost(sql: SqlStorage, command: Extract<PoolCommand, { type: "CreateMessageBoardPost" }>): PoolCommandResult {
    const activityAt = this.nextMessageBoardActivityAt(sql);
    const postId = crypto.randomUUID();
    sql.exec("INSERT INTO message_board_entry (id, parent_post_id, author_id, text, created_at, activity_at, is_announcement) VALUES (?, NULL, ?, ?, ?, ?, ?)", postId, command.actorId, command.text, activityAt, activityAt, command.announcement ? 1 : 0);
    this.advanceMessageBoardRead(sql, command.actorId, activityAt);
    return { commandVersion: this.bumpVersion(sql), postId, isAnnouncement: command.announcement, replayed: false };
  }

  private replyToMessageBoardPost(sql: SqlStorage, command: Extract<PoolCommand, { type: "ReplyToMessageBoardPost" }>): PoolCommandResult {
    const parent = first(sql, "SELECT parent_post_id FROM message_board_entry WHERE id = ?", command.postId);
    if (!parent) throw new Error("MESSAGE_BOARD_POST_NOT_FOUND");
    if (parent.parent_post_id !== null) throw new Error("MESSAGE_BOARD_REPLY_NOT_ALLOWED");
    const activityAt = this.nextMessageBoardActivityAt(sql);
    sql.exec("INSERT INTO message_board_entry (id, parent_post_id, author_id, text, created_at, activity_at) VALUES (?, ?, ?, ?, ?, ?)", crypto.randomUUID(), command.postId, command.actorId, command.text, activityAt, activityAt);
    sql.exec("UPDATE message_board_entry SET activity_at = ? WHERE id = ?", activityAt, command.postId);
    this.advanceMessageBoardRead(sql, command.actorId, activityAt);
    return { commandVersion: this.bumpVersion(sql) };
  }

  private nextMessageBoardActivityAt(sql: SqlStorage): string {
    const latest = first(sql, "SELECT activity_at FROM message_board_entry ORDER BY activity_at DESC, id DESC LIMIT 1");
    const currentAt = this.authoritativeTime().getTime();
    const latestAt = latest?.activity_at === null || latest?.activity_at === undefined ? Number.NEGATIVE_INFINITY : Date.parse(String(latest.activity_at));
    return new Date(Number.isFinite(latestAt) ? Math.max(currentAt, latestAt + 1) : currentAt).toISOString();
  }

  private advanceMessageBoardRead(sql: SqlStorage, memberId: string, activityAt: string): void {
    sql.exec("INSERT INTO message_board_read (member_id, last_read_at) VALUES (?, ?) ON CONFLICT(member_id) DO UPDATE SET last_read_at = CASE WHEN excluded.last_read_at > message_board_read.last_read_at THEN excluded.last_read_at ELSE message_board_read.last_read_at END", memberId, activityAt);
  }

  private requireActiveMember(sql: SqlStorage, memberId: string): void {
    const member = first(sql, "SELECT status FROM member WHERE user_id = ?", memberId);
    if (!member) throw new Error("MEMBER_NOT_FOUND");
    if (member.status !== "active") throw new Error("SUSPENDED");
  }

  /** The authoritative clock for human privacy boundaries; production always uses real time. */
  protected authoritativeTime(): Date { return new Date(); }

  private bumpVersion(sql: SqlStorage): string {
    const pool = first(sql, "SELECT command_version FROM pool LIMIT 1")!;
    const version = (BigInt(String(pool.command_version)) + 1n).toString();
    sql.exec("UPDATE pool SET command_version = ?", version);
    sql.exec("UPDATE season SET command_version = ? WHERE id = (SELECT active_season_id FROM pool LIMIT 1)", version);
    return version;
  }

  protected async alarm(currentTime = Date.now()): Promise<void> {
    const settlementDeadline = this.env.DB ? await runSettlementAlarm(this.state, this.env.DB, undefined, currentTime) : null;
    await drainOutbox(this.state, this.env.POOL_EVENTS, new Date(), this.env.DB);
    const outboxDeadline = this.env.POOL_EVENTS ? nextOutboxAttempt(this.state) : null;
    const deadlines = [settlementDeadline, outboxDeadline].filter((deadline): deadline is number => deadline !== null && Number.isFinite(deadline));
    // Queue retries are never allowed to replace or delay result coverage.
    if (deadlines.length) await this.state.storage.setAlarm(Math.min(...deadlines));
  }

  /** Deliberately minimal service-only snapshot for repairable D1 directory projections. */
  private projectionSnapshot(sql: SqlStorage) {
    const pool = first(sql, "SELECT id, name, command_version FROM pool LIMIT 1");
    if (!pool) throw new Error("POOL_NOT_INITIALIZED");
    return {
      poolId: String(pool.id), commandVersion: String(pool.command_version), poolName: String(pool.name),
      members: [...sql.exec<Row>("SELECT user_id, display_name, role, status FROM member ORDER BY joined_at")].map((member) => ({ userId: String(member.user_id), displayName: String(member.display_name), role: String(member.role), status: String(member.status) })),
      seasons: [...sql.exec<Row>("SELECT id, label, state, opened_at, closed_at FROM season ORDER BY id")].map((season) => ({ seasonId: String(season.id), label: String(season.label), state: String(season.state), openedAt: season.opened_at === null ? null : String(season.opened_at), closedAt: season.closed_at === null ? null : String(season.closed_at) }))
    };
  }

  private standings(sql: SqlStorage, activeSeasonId: SqlStorageValue | undefined) {
    if (activeSeasonId === null || activeSeasonId === undefined) return [];
    const season = first(sql, "SELECT float_micros, notional_micros FROM season WHERE id = ?", activeSeasonId)!;
    const float = BigInt(String(season.float_micros)); const notional = BigInt(String(season.notional_micros));
    const price = float === 0n ? MICROS_PER_UNIT : divideRoundHalfEven(notional * MICROS_PER_UNIT, float);
    const rows = [...sql.exec<Row>("SELECT m.user_id, m.display_name, a.available_micros, a.locked_micros FROM member m JOIN share_account a ON a.member_id = m.user_id WHERE a.season_id = ?", activeSeasonId)].map((row) => {
      const holdings = BigInt(String(row.available_micros)) + BigInt(String(row.locked_micros));
      const issuedMicros = [...sql.exec<Row>("SELECT value_micros FROM share_order WHERE season_id = ? AND member_id = ? ORDER BY created_at, rowid", activeSeasonId, row.user_id)].reduce((sum, order) => sum + BigInt(String(order.value_micros)), 0n);
      // The immutable ledger, not orders alone, records every holdings transition (including settlement).
      let running = 0n; let attained = "";
      for (const entry of sql.exec<Row>("SELECT available_delta, locked_delta, created_at FROM ledger_entry WHERE season_id = ? AND member_id = ? ORDER BY created_at, rowid", activeSeasonId, row.user_id)) { running += BigInt(String(entry.available_delta)) + BigInt(String(entry.locked_delta)); if (!attained && running === holdings) attained = String(entry.created_at); }
      return { row, holdings, attained, issuedMicros };
    });
    const gain = (row: typeof rows[number]) => divideRoundHalfEven(row.holdings * price, MICROS_PER_UNIT) - row.issuedMicros;
    rows.sort((a, b) => gain(a) === gain(b) ? (a.holdings === b.holdings ? (a.attained || "~").localeCompare(b.attained || "~") || String(a.row.display_name).localeCompare(String(b.row.display_name)) : a.holdings > b.holdings ? -1 : 1) : gain(a) > gain(b) ? -1 : 1);
    return rows.map(({ row, holdings, issuedMicros }, index) => {
      const value = divideRoundHalfEven(holdings * price, MICROS_PER_UNIT);
      return { rank: index + 1, userId: String(row.user_id), displayName: String(row.display_name), availableMicros: String(row.available_micros), lockedMicros: String(row.locked_micros), totalMicros: holdings.toString(), priceMicros: price.toString(), notionalValueMicros: value.toString(), gainMicros: (value - issuedMicros).toString() };
    });
  }

  private activity(sql: SqlStorage, actorId: string) {
    return { orders: [...sql.exec<Row>("SELECT o.id, o.member_id, m.display_name, o.shares_micros, o.value_micros, o.price_micros, o.reason, o.created_at FROM share_order o JOIN member m ON m.user_id = o.member_id ORDER BY o.created_at DESC, o.rowid DESC")].map((order) => ({ orderId: String(order.id), memberId: String(order.member_id), memberDisplayName: String(order.display_name), sharesMicros: String(order.shares_micros), valueMicros: String(order.value_micros), priceMicros: String(order.price_micros), reason: String(order.reason), createdAt: String(order.created_at) })), ...shapeWagers(sql, actorId, this.authoritativeTime(), false, undefined, true) };
  }

  private history(sql: SqlStorage, seasonId: string, actorId: string) {
    const season = first(sql, "SELECT id, label, ruleset_version, state, opened_at, closed_at, close_reason, float_micros, notional_micros FROM season WHERE id = ?", seasonId);
    if (!season) throw new Error("SEASON_NOT_FOUND");
    if (season.state !== "closed") throw new Error("SEASON_NOT_CLOSED");
    const floatMicros = BigInt(String(season.float_micros));
    const notionalMicros = BigInt(String(season.notional_micros));
    const priceMicros = floatMicros === 0n ? MICROS_PER_UNIT : divideRoundHalfEven(notionalMicros * MICROS_PER_UNIT, floatMicros);
    const standings = this.standings(sql, seasonId);
    const accounts = standings.slice().sort((a, b) => a.userId.localeCompare(b.userId)).map((standing) => ({ memberId: standing.userId, memberDisplayName: standing.displayName, availableMicros: standing.availableMicros, lockedMicros: standing.lockedMicros, totalMicros: standing.totalMicros, holdingValueMicros: standing.notionalValueMicros, gainMicros: standing.gainMicros }));
    const text = (value: SqlStorageValue | null | undefined) => value === null || value === undefined ? null : String(value);
    const orders = [...sql.exec<Row>("SELECT o.id, o.season_id, o.member_id, m.display_name, o.actor_id, o.mode, o.requested_micros, o.shares_micros, o.value_micros, o.price_micros, o.reversal_of, o.reason, o.command_id, o.created_at FROM share_order o JOIN member m ON m.user_id = o.member_id WHERE o.season_id = ? ORDER BY o.created_at, o.rowid", seasonId)].map((row) => ({ id: String(row.id), seasonId: String(row.season_id), memberId: String(row.member_id), memberDisplayName: String(row.display_name), actorId: String(row.actor_id), mode: String(row.mode), requestedMicros: String(row.requested_micros), sharesMicros: String(row.shares_micros), valueMicros: String(row.value_micros), priceMicros: String(row.price_micros), reversalOf: text(row.reversal_of), reason: String(row.reason), commandId: String(row.command_id), createdAt: String(row.created_at) }));
    const ledger = [...sql.exec<Row>("SELECT l.id, l.season_id, l.member_id, m.display_name, l.actor_id, l.available_delta, l.locked_delta, l.float_delta, l.notional_delta, l.causation_id, l.kind, l.created_at FROM ledger_entry l JOIN member m ON m.user_id = l.member_id WHERE l.season_id = ? ORDER BY l.created_at, l.rowid", seasonId)].map((row) => ({ id: String(row.id), seasonId: String(row.season_id), memberId: String(row.member_id), memberDisplayName: String(row.display_name), actorId: String(row.actor_id), availableDelta: String(row.available_delta), lockedDelta: String(row.locked_delta), floatDelta: String(row.float_delta), notionalDelta: String(row.notional_delta), causationId: String(row.causation_id), kind: String(row.kind), createdAt: String(row.created_at) }));
    const settlements = [...sql.exec<Row>("SELECT s.id, s.wager_id, s.result_version, s.outcome, s.return_micros, s.profit_micros, s.settled_odds, s.source_result_json, s.reversal_of, s.actor_id, s.reason, s.created_at FROM settlement s JOIN wager w ON w.id = s.wager_id WHERE w.season_id = ? ORDER BY s.created_at, s.rowid", seasonId)].map((row) => ({ id: String(row.id), wagerId: String(row.wager_id), resultVersion: String(row.result_version), outcome: String(row.outcome), returnMicros: String(row.return_micros), profitMicros: String(row.profit_micros), settledOdds: row.settled_odds === null ? null : Number(row.settled_odds), sourceResult: JSON.parse(String(row.source_result_json)), reversalOf: text(row.reversal_of), actorId: String(row.actor_id), reason: text(row.reason), createdAt: String(row.created_at) }));
    const wagerCorrections = [...sql.exec<Row>("SELECT c.id, c.wager_id, c.actor_id, c.reason, c.source_result_json, c.replacement_result_json, c.command_id, c.created_at FROM wager_correction c JOIN wager w ON w.id = c.wager_id WHERE w.season_id = ? ORDER BY c.created_at, c.rowid", seasonId)].map((row) => ({ id: String(row.id), wagerId: String(row.wager_id), actorId: String(row.actor_id), reason: String(row.reason), sourceResult: JSON.parse(String(row.source_result_json)), replacementResult: JSON.parse(String(row.replacement_result_json)), commandId: String(row.command_id), createdAt: String(row.created_at) }));
    const eventResults = [...sql.exec<Row>("SELECT event_id, result_json, observed_at FROM season_provider_result WHERE season_id = ? ORDER BY append_order", seasonId)].map((row) => ({ eventId: String(row.event_id), result: JSON.parse(String(row.result_json)), observedAt: String(row.observed_at) }));
    return {
      season: { seasonId: String(season.id), label: String(season.label), rulesetVersion: String(season.ruleset_version), state: String(season.state), openedAt: text(season.opened_at), closedAt: text(season.closed_at), closeReason: text(season.close_reason), floatMicros: floatMicros.toString(), notionalMicros: notionalMicros.toString(), priceMicros: priceMicros.toString() },
      accounts, standings, orders, ledger, settlements, wagerCorrections, eventResults,
      annotations: [...sql.exec<Row>("SELECT a.id, m.display_name, a.text, a.created_at FROM season_annotation a JOIN member m ON m.user_id = a.actor_id WHERE a.season_id = ? ORDER BY a.created_at, a.rowid", seasonId)].map((annotation) => ({ annotationId: String(annotation.id), authorDisplayName: String(annotation.display_name), text: String(annotation.text), createdAt: String(annotation.created_at) })),
      ...shapeWagers(sql, actorId, this.authoritativeTime(), false, seasonId)
    };
  }

  private readPool(sql: SqlStorage, actorId: string, commandVersion: string, activeSeasonId: SqlStorageValue | undefined): PoolCommandResult {
    const pool = first(sql, "SELECT id, slug, name, commissioner_id, signups_open, max_side_bet_micros, commissioner_notice FROM pool LIMIT 1")!;
    const currentRole = String(first(sql, "SELECT role FROM member WHERE user_id = ?", actorId)!.role) as "commissioner" | "member";
    const summary = (season: Row | undefined) => !season ? null : ({ id: String(season.id), label: String(season.label), rulesetVersion: String(season.ruleset_version), state: String(season.state), createdAt: String(season.created_at), openedAt: season.opened_at === null ? null : String(season.opened_at), closedAt: season.closed_at === null ? null : String(season.closed_at), defaultOrderMode: season.default_mode === null ? null : String(season.default_mode), defaultOrderAmountMicros: season.default_amount_micros === null ? null : String(season.default_amount_micros), floatMicros: String(season.float_micros), notionalValueMicros: String(season.notional_micros), superBowlCandidate: (() => { const candidate = first(sql, "SELECT event_id, provider_event_name, confirmed_at FROM season_super_bowl WHERE season_id = ?", season.id); return candidate ? { eventId: String(candidate.event_id), providerEventName: String(candidate.provider_event_name), confirmedAt: candidate.confirmed_at === null ? null : String(candidate.confirmed_at) } : null; })(), ...(String(season.state) === "closed" ? { closeReason: season.close_reason === null ? null : String(season.close_reason) } : {}) });
    const active = activeSeasonId === null || activeSeasonId === undefined ? undefined : first(sql, "SELECT * FROM season WHERE id = ? AND state = 'active'", activeSeasonId);
    const draft = first(sql, "SELECT * FROM season WHERE state = 'draft' ORDER BY created_at ASC, id ASC LIMIT 1");
    const closed = first(sql, "SELECT * FROM season WHERE state = 'closed' ORDER BY closed_at DESC, id ASC LIMIT 1");
    const lifecycleIds = [active, draft, closed].filter((season): season is Row => Boolean(season)).map((season) => String(season.id));
    const seasonBalances = lifecycleIds.map((seasonId) => {
      const account = first(sql, "SELECT available_micros, locked_micros FROM share_account WHERE season_id = ? AND member_id = ?", seasonId, actorId);
      return { seasonId, availableMicros: account ? String(account.available_micros) : "0", lockedMicros: account ? String(account.locked_micros) : "0" };
    });
    const members = [...sql.exec<Row>("SELECT user_id, display_name, role, status FROM member ORDER BY joined_at, user_id")].map((member) => ({ memberId: String(member.user_id), displayName: String(member.display_name), role: String(member.role), status: String(member.status) }));
    const seasonOrders = lifecycleIds.map((seasonId) => ({ seasonId, orders: [...sql.exec<Row>("SELECT id, member_id, mode, requested_micros, shares_micros, value_micros, price_micros, reversal_of, reason, created_at FROM share_order WHERE season_id = ? ORDER BY created_at DESC, rowid DESC", seasonId)].map((order) => ({ orderId: String(order.id), memberId: String(order.member_id), mode: String(order.mode), requestedMicros: String(order.requested_micros), sharesMicros: String(order.shares_micros), valueMicros: String(order.value_micros), priceMicros: String(order.price_micros), reversalOf: order.reversal_of === null ? null : String(order.reversal_of), reason: String(order.reason), createdAt: String(order.created_at) })) }));
    const latestBoardActivity = first(sql, "SELECT activity_at FROM message_board_entry WHERE parent_post_id IS NULL ORDER BY activity_at DESC, id DESC LIMIT 1");
    const boardRead = first(sql, "SELECT last_read_at FROM message_board_read WHERE member_id = ?", actorId);
    const hasUnreadBoard = latestBoardActivity?.activity_at !== null && latestBoardActivity?.activity_at !== undefined
      && (boardRead?.last_read_at === null || boardRead?.last_read_at === undefined || String(latestBoardActivity.activity_at) > String(boardRead.last_read_at));
    return { commandVersion, pool: { poolId: String(pool.id), slug: String(pool.slug), name: String(pool.name), commissionerId: String(pool.commissioner_id), signupsOpen: Boolean(pool.signups_open), maxSideBetMicros: String(pool.max_side_bet_micros), commissionerNotice: pool.commissioner_notice === null || pool.commissioner_notice === undefined ? null : String(pool.commissioner_notice) }, activeSeason: summary(active), nextDraftSeason: summary(draft), latestClosedSeason: summary(closed), currentMember: { memberId: actorId, role: currentRole, seasonBalances, hasUnreadBoard }, members, commissioner: currentRole === "commissioner" ? { seasonOrders } : null };
  }
}
