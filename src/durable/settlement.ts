import { americanProfitMicros } from "../domain/odds";
import { gradeLeg, gradeTeaser } from "../domain/grading";
import type { LegGrade, TeaserLeg } from "../domain/types";
import type { CorrectedEventResult } from "../contracts/commands";
import { parseIntegerText } from "../domain/fixed-point";
import type { FinalResultVersion } from "../odds/result-source";
import { enqueueOutbox } from "./outbox";
import { gradeParlay, PARLAY_RULESET_ID } from "../domain/parlay";
import type { TeaserPoints } from "../domain/teaser-table";

type Sql = { exec(query: string, ...params: SqlStorageValue[]): Iterable<Record<string, SqlStorageValue>> };
type Row = Record<string, SqlStorageValue>;
const first = (sql: Sql, query: string, ...params: SqlStorageValue[]) => [...sql.exec(query, ...params)][0];
const currentSettlement = (sql: Sql, wagerId: SqlStorageValue) => first(sql, "SELECT s.* FROM settlement s WHERE s.wager_id = ? AND s.outcome <> 'reversal' AND NOT EXISTS (SELECT 1 FROM settlement r WHERE r.reversal_of = s.id) ORDER BY s.created_at DESC LIMIT 1", wagerId);
const iso = () => new Date().toISOString();

type GradedResult = { grades: LegGrade[]; outcome: "win" | "loss" | "refund"; profit: bigint; odds: number | null };
const resultKey = (eventId: string, league: string) => `${eventId}\u0000${league}`;
export const providerResultIdentity = (result: FinalResultVersion) => `${resultKey(result.eventId, result.league)}\u0000${result.correctionVersion}`;
const appendProviderResults = (sql: Sql, seasonId: string, results: readonly FinalResultVersion[], observedAt: ReadonlyMap<string, string>): void => {
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const ordered = [...new Map(results.map((result) => [providerResultIdentity(result), result])).values()].sort((left, right) =>
    compare(left.eventId, right.eventId) || compare(left.league, right.league) || compare(left.correctionVersion, right.correctionVersion)
  );
  let next = Number(first(sql, "SELECT COALESCE(MAX(append_order), 0) AS value FROM season_provider_result WHERE season_id = ?", seasonId)?.value ?? 0) + 1;
  for (const result of ordered) {
    const inserted = [...sql.exec("INSERT OR IGNORE INTO season_provider_result (season_id, event_id, league, correction_version, result_json, observed_at, append_order) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING append_order", seasonId, result.eventId, result.league, result.correctionVersion, JSON.stringify(result), observedAt.get(providerResultIdentity(result)) ?? iso(), next)][0];
    if (inserted) next++;
  }
};
const canonicalResults = (legs: readonly Row[], byKey: ReadonlyMap<string, FinalResultVersion>): FinalResultVersion[] => {
  const seen = new Set<string>();
  return legs.flatMap((leg) => {
    const key = resultKey(String(leg.event_id), String(leg.league));
    if (seen.has(key)) return [];
    seen.add(key);
    const result = byKey.get(key);
    return result ? [result] : [];
  });
};
const gradesFor = (legs: readonly Row[], byKey: ReadonlyMap<string, FinalResultVersion>): LegGrade[] => legs.map((leg) => {
  const result = byKey.get(resultKey(String(leg.event_id), String(leg.league)));
  if (!result) return "pending";
  return gradeLeg({ eventId: String(leg.event_id), market: String(leg.market) as TeaserLeg["market"], selection: String(leg.selection) as TeaserLeg["selection"], ...(leg.adjusted_line === null ? leg.original_line === null ? {} : { line: Number(leg.original_line) } : { line: Number(leg.adjusted_line) }) } as TeaserLeg, { home: result.homeScore ?? 0, away: result.awayScore ?? 0, status: result.status });
});
function gradeResults(wager: Row, legs: Row[], source: readonly FinalResultVersion[], grades = gradesFor(legs, new Map(source.map((result) => [resultKey(result.eventId, result.league), result])))): GradedResult | null {
  // A loss is immediately decisive for either multi-leg ticket. Every other
  // outcome still needs the complete result set for push/void repricing.
  if (grades.includes("pending") && !grades.includes("loss")) return null;
  const teaserGrade = String(wager.type) === "teaser" ? gradeTeaser(grades, Number(legs[0].teaser_adjustment) as TeaserPoints) : undefined;
  const parlayGrade = String(wager.type) === "parlay"
    ? String(wager.ruleset_version) === PARLAY_RULESET_ID
      ? gradeParlay(grades, legs.map((leg) => ({ eventId: String(leg.event_id), market: String(leg.market) as "spread" | "total" | "moneyline", selection: String(leg.selection) as "home" | "away" | "over" | "under", originalOdds: Number(leg.original_odds) })))
      : (() => { throw new Error("INVALID_PARLAY_RULESET"); })()
    : undefined;
  const outcome = parlayGrade?.outcome ?? teaserGrade?.outcome ?? (grades[0] === "win" ? "win" : grades[0] === "loss" ? "loss" : "refund");
  const effectiveParlayOdds = parlayGrade?.outcome === "win" ? parlayGrade.odds : undefined;
  const odds = outcome === "win" ? effectiveParlayOdds ?? teaserGrade?.odds ?? Number(wager.accepted_odds) : null;
  const profit = odds === null ? 0n : americanProfitMicros(parseIntegerText(String(wager.risk_micros)), odds);
  return { grades, outcome, profit, odds };
}
const automaticPartialLoss = (prior: Row, legs: readonly Row[]): boolean => {
  if (String(prior.actor_id) !== "system" || String(prior.outcome) !== "loss") return false;
  let evidence: unknown;
  try { evidence = JSON.parse(String(prior.source_result_json)); } catch { return false; }
  if (!Array.isArray(evidence)) return false;
  const required = new Set(legs.map((leg) => resultKey(String(leg.event_id), String(leg.league))));
  const observed = new Set(evidence.flatMap((result): string[] => {
    if (!result || typeof result !== "object") return [];
    const row = result as { eventId?: unknown; league?: unknown };
    return typeof row.eventId === "string" && typeof row.league === "string" ? [resultKey(row.eventId, row.league)] : [];
  }));
  return observed.size < required.size;
};
const updateObservedLegs = (sql: Sql, legs: readonly Row[], grades: readonly LegGrade[], byEvent: ReadonlyMap<string, FinalResultVersion>): void => {
  for (let index = 0; index < legs.length; index++) {
    const result = byEvent.get(resultKey(String(legs[index].event_id), String(legs[index].league)));
    if (result) sql.exec("UPDATE wager_leg SET grade = ?, result_version = ? WHERE id = ?", grades[index], result.correctionVersion, legs[index].id);
  }
};

/** Applies final/corrected D1 results to accepted immutable ticket legs in active seasons. */
export function settleWagers(sql: Sql, results: readonly FinalResultVersion[], observedAt: ReadonlyMap<string, string> = new Map()): number {
  const byEvent = new Map(results.map((result) => [resultKey(result.eventId, result.league), result]));
  let settled = 0;
  const applied: Array<{ wager: Row; source: FinalResultVersion[]; identity: Array<{ eventId: string; correctionVersion: string }>; priorResultVersion?: string }> = [];
  for (const wager of sql.exec("SELECT w.* FROM wager w JOIN season s ON s.id = w.season_id WHERE s.state = 'active'")) {
    const legs = [...sql.exec("SELECT * FROM wager_leg WHERE wager_id = ? ORDER BY id", wager.id)];
    if (!legs.length) continue;
    const source = canonicalResults(legs, byEvent);
    if (!source.length) continue;
    // A provider can publish final before scores. Never turn that transient
    // malformed final into a synthetic 0-0 accounting result.
    if (source.some((result) => result.status === "final" && (result.homeScore === null || result.awayScore === null))) continue;
    const version = JSON.stringify(source.map((result) => [result.eventId, result.correctionVersion]));
    // Provider observation identity lives on each immutable leg. A manual
    // settlement has its own effective identity and must not make an unchanged
    // final_15/final_24 observation look new.
    const observedLegs = legs.filter((leg) => byEvent.has(resultKey(String(leg.event_id), String(leg.league))));
    if (observedLegs.every((leg) => String(leg.result_version ?? "") === byEvent.get(resultKey(String(leg.event_id), String(leg.league)))!.correctionVersion)) continue;
    const grades = gradesFor(legs, byEvent);
    const graded = gradeResults(wager, legs, source, grades);
    const prior = currentSettlement(sql, wager.id);
    if (prior && String(prior.actor_id) !== "system" && grades.includes("pending")) continue;
    if (!graded) {
      // Only an automatic loss applied from incomplete provider evidence may be
      // reopened by another incomplete provider observation. Commissioner
      // corrections remain authoritative until the provider set is complete.
      if (!prior || !automaticPartialLoss(prior, legs)) continue;
      reversePrior(sql, wager, prior);
      sql.exec("UPDATE wager SET status = 'open', settled_result_version = NULL WHERE id = ?", wager.id);
      updateObservedLegs(sql, legs, grades, byEvent);
      applied.push({ wager, source, identity: source.map((result) => ({ eventId: result.eventId, correctionVersion: result.correctionVersion })), priorResultVersion: String(prior.result_version) });
      settled++;
      continue;
    }
    const { outcome, profit, odds } = graded;
    const risk = parseIntegerText(String(wager.risk_micros));
    if (prior) reversePrior(sql, wager, prior);
    apply(sql, wager, outcome, risk, profit, odds, version, JSON.stringify(source), prior ? String(prior.id) : null);
    updateObservedLegs(sql, legs, grades, byEvent);
    applied.push({ wager, source, identity: source.map((result) => ({ eventId: result.eventId, correctionVersion: result.correctionVersion })), ...(prior ? { priorResultVersion: String(prior.result_version) } : {}) });
    settled++;
  }
  const evidenceBySeason = new Map<string, FinalResultVersion[]>();
  for (const event of applied) evidenceBySeason.set(String(event.wager.season_id), [...(evidenceBySeason.get(String(event.wager.season_id)) ?? []), ...event.source]);
  for (const [seasonId, evidence] of [...evidenceBySeason].sort(([left], [right]) => left.localeCompare(right))) appendProviderResults(sql, seasonId, evidence, observedAt);
  const closed = closeEligibleSeasons(sql, results, observedAt);
  if (settled || closed.length) {
    const pool = first(sql, "SELECT id, command_version FROM pool LIMIT 1")!;
    const version = (BigInt(String(pool.command_version)) + 1n).toString();
    sql.exec("UPDATE pool SET command_version = ?", version);
    sql.exec("UPDATE season SET command_version = ? WHERE id = (SELECT active_season_id FROM pool LIMIT 1)", version);
    for (const season of closed) sql.exec("UPDATE season SET command_version = ? WHERE id = ?", version, season.id);
    for (const event of applied) enqueueOutbox(sql as SqlStorage, { eventId: crypto.randomUUID(), eventType: event.priorResultVersion ? "SettlementRegraded" : "SettlementApplied", version, payload: { poolId: String(pool.id), seasonId: String(event.wager.season_id), memberId: String(event.wager.owner_id), wagerId: String(event.wager.id), resultIdentity: event.identity, ...(event.priorResultVersion ? { priorResultVersion: event.priorResultVersion } : {}) } } as import("./outbox").PoolOutboxMessage);
    for (const season of closed) enqueueOutbox(sql as SqlStorage, { eventId: crypto.randomUUID(), eventType: "SeasonClosed", version, payload: { poolId: String(pool.id), seasonId: season.id, closeReason: season.reason } });
  }
  return settled;
}

function reversePrior(sql: Sql, wager: Row, prior: Row, actorId = "system", reason: string | null = null): void {
  const returnMicros = parseIntegerText(String(prior.return_micros)); const profit = parseIntegerText(String(prior.profit_micros));
  const priorOutcome = String(prior.outcome);
  // Regrading restores the original locked risk before applying its replacement outcome.
  const available = -(returnMicros); const locked = parseIntegerText(String(wager.risk_micros));
  // Settlement rows keep the internal win/loss/refund vocabulary; won/lost is the published/wager-status vocabulary.
  const float = priorOutcome === "win" ? -profit : priorOutcome === "loss" ? parseIntegerText(String(wager.risk_micros)) : 0n;
  applyLedger(sql, wager, available, locked, float, `reversal:${prior.id}`, "settlement_reversal", actorId);
  sql.exec("INSERT INTO settlement (id, wager_id, result_version, outcome, return_micros, profit_micros, settled_odds, source_result_json, reversal_of, actor_id, reason, created_at) VALUES (?, ?, ?, 'reversal', ?, ?, NULL, ?, ?, ?, ?, ?)", crypto.randomUUID(), wager.id, String(prior.result_version), (-returnMicros).toString(), (-profit).toString(), String(prior.source_result_json), prior.id, actorId, reason, iso());
}
function apply(sql: Sql, wager: Row, outcome: string, risk: bigint, profit: bigint, odds: number | null, version: string, source: string, reversalOf: string | null, actorId = "system", reason: string | null = null): void {
  const available = outcome === "win" ? risk + profit : outcome === "refund" ? risk : 0n;
  const locked = -risk; const float = outcome === "win" ? profit : outcome === "loss" ? -risk : 0n;
  applyLedger(sql, wager, available, locked, float, String(wager.id), "settlement", actorId);
  sql.exec("UPDATE wager SET status = ?, settled_result_version = ? WHERE id = ?", outcome === "win" ? "won" : outcome === "loss" ? "lost" : "refunded", version, wager.id);
  sql.exec("INSERT INTO settlement (id, wager_id, result_version, outcome, return_micros, profit_micros, settled_odds, source_result_json, reversal_of, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", crypto.randomUUID(), wager.id, version, outcome, available.toString(), profit.toString(), outcome === "win" ? odds : null, source, reversalOf, actorId, reason, iso());
}
function applyLedger(sql: Sql, wager: Row, available: bigint, locked: bigint, float: bigint, causation: string, kind: string, actorId = "system"): void {
  const account = first(sql, "SELECT available_micros, locked_micros FROM share_account WHERE season_id = ? AND member_id = ?", wager.season_id, wager.owner_id)!;
  const nextAvailable = parseIntegerText(String(account.available_micros)) + available; const nextLocked = parseIntegerText(String(account.locked_micros)) + locked;
  if (nextAvailable < 0n || nextLocked < 0n) throw new Error("NEGATIVE_ACCOUNT");
  const season = first(sql, "SELECT float_micros FROM season WHERE id = ?", wager.season_id)!; const nextFloat = parseIntegerText(String(season.float_micros)) + float;
  if (nextFloat < 0n) throw new Error("NEGATIVE_FLOAT");
  sql.exec("UPDATE share_account SET available_micros = ?, locked_micros = ?, row_version = row_version + 1 WHERE season_id = ? AND member_id = ?", nextAvailable.toString(), nextLocked.toString(), wager.season_id, wager.owner_id);
  sql.exec("UPDATE season SET float_micros = ? WHERE id = ?", nextFloat.toString(), wager.season_id);
  sql.exec("INSERT INTO ledger_entry (id, season_id, member_id, actor_id, available_delta, locked_delta, float_delta, notional_delta, causation_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?)", crypto.randomUUID(), wager.season_id, wager.owner_id, actorId, available.toString(), locked.toString(), float.toString(), causation, kind, iso());
}
function applyAdministrativeCorrection(sql: Sql, wager: Row, actorId: string, reason: string, commandId: string, outcome: "win" | "loss" | "refund", profit: bigint, odds: number | null, resultVersion: string, replacement: string, grades?: readonly string[]): Array<{ id: string; reason: "float_exhausted" | "super_bowl_final" }> {
  const prior = currentSettlement(sql, wager.id);
  const source = prior ? String(prior.source_result_json) : JSON.stringify({ status: "open", wagerId: wager.id });
  if (prior) reversePrior(sql, wager, prior, actorId, reason);
  const risk = parseIntegerText(String(wager.risk_micros));
  apply(sql, wager, outcome, risk, profit, outcome === "win" ? odds : null, resultVersion, replacement, prior ? String(prior.id) : null, actorId, reason);
  if (grades) {
    const legs = [...sql.exec("SELECT id FROM wager_leg WHERE wager_id = ? ORDER BY id", wager.id)];
    for (let index = 0; index < legs.length; index++) sql.exec("UPDATE wager_leg SET grade = ? WHERE id = ?", grades[index], legs[index].id);
  }
  sql.exec("INSERT INTO wager_correction (id, wager_id, actor_id, reason, source_result_json, replacement_result_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", crypto.randomUUID(), wager.id, actorId, reason, source, replacement, commandId, iso());
  return closeEligibleSeasons(sql);
}

/** Regrade from public corrected event evidence and immutable server-side wager terms. */
export function correctWager(sql: Sql, wager: Row, actorId: string, reason: string, commandId: string, correctedResults: readonly CorrectedEventResult[]): Array<{ id: string; reason: "float_exhausted" | "super_bowl_final" }> {
  const legs = [...sql.exec("SELECT * FROM wager_leg WHERE wager_id = ? ORDER BY id", wager.id)];
  const byEvent = new Map(correctedResults.map((result) => [resultKey(result.eventId, result.league), result]));
  const wagerEvidence = new Set(legs.map((leg) => resultKey(String(leg.event_id), String(leg.league))));
  if (byEvent.size !== correctedResults.length || wagerEvidence.size !== correctedResults.length || [...wagerEvidence].some((key) => !byEvent.has(key))) throw new Error("CORRECTION_RESULT_MISMATCH");
  const ordered = canonicalResults(legs, byEvent);
  const graded = gradeResults(wager, legs, ordered);
  if (!graded) throw new Error("CORRECTION_RESULT_INVALID");
  const resultVersion = `commissioner:${commandId}:${JSON.stringify(ordered.map((result) => [result.eventId, result.correctionVersion]))}`;
  const replacement = JSON.stringify({ source: "commissioner_correction", commandId, correctedResults: ordered, derived: { outcome: graded.outcome, odds: graded.odds } });
  return applyAdministrativeCorrection(sql, wager, actorId, reason, commandId, graded.outcome, graded.profit, graded.odds, resultVersion, replacement, graded.grades);
}

/** A commissioner void is an administrative refund, not a synthetic event regrade. */
export function voidWager(sql: Sql, wager: Row, actorId: string, reason: string, commandId: string): Array<{ id: string; reason: "float_exhausted" | "super_bowl_final" }> {
  const replacement = JSON.stringify({ source: "commissioner_void", commandId, outcome: "refund" });
  return applyAdministrativeCorrection(sql, wager, actorId, reason, commandId, "refund", 0n, null, `commissioner-void:${commandId}`, replacement);
}

function closeEligibleSeasons(sql: Sql, observedResults: readonly FinalResultVersion[] = [], observedAt: ReadonlyMap<string, string> = new Map()): Array<{ id: string; reason: "float_exhausted" | "super_bowl_final" }> {
  const closed: Array<{ id: string; reason: "float_exhausted" | "super_bowl_final" }> = [];
  const current = new Map(observedResults.map((result) => [resultKey(result.eventId, result.league), result]));
  for (const season of sql.exec("SELECT id, float_micros FROM season WHERE state = 'active'")) {
    const exhaustedByLoss = first(sql, "SELECT 1 FROM ledger_entry WHERE season_id = ? AND kind = 'settlement' AND float_delta LIKE '-%' LIMIT 1", season.id);
    const unresolved = first(sql, "SELECT 1 FROM wager w WHERE w.season_id = ? AND (w.status = 'open' OR (w.type IN ('teaser','parlay') AND EXISTS (SELECT 1 FROM wager_leg l WHERE l.wager_id = w.id AND l.grade IS NULL))) LIMIT 1", season.id);
    if (String(season.float_micros) === "0" && exhaustedByLoss && !unresolved) { sql.exec("UPDATE season SET state = 'closed', close_reason = 'float_exhausted', closed_at = ? WHERE id = ?", iso(), season.id); sql.exec("UPDATE pool SET active_season_id = NULL WHERE active_season_id = ?", season.id); closed.push({ id: String(season.id), reason: "float_exhausted" }); continue; }
    const superBowl = first(sql, "SELECT sb.event_id FROM season_super_bowl sb WHERE sb.season_id = ? AND sb.confirmed_at IS NOT NULL", season.id);
    let finalSuperBowl = superBowl ? current.get(resultKey(String(superBowl.event_id), "nfl")) : undefined;
    let causalObservedAt = observedAt;
    if (!finalSuperBowl && superBowl) {
      const snapshot = first(sql, "SELECT result_json, observed_at FROM event_result_snapshot WHERE event_id = ?", superBowl.event_id);
      if (snapshot) {
        const candidate = JSON.parse(String(snapshot.result_json)) as FinalResultVersion;
        if (candidate.status === "final") {
          finalSuperBowl = candidate;
          causalObservedAt = new Map([[providerResultIdentity(candidate), String(snapshot.observed_at)]]);
        }
      }
    }
    if (finalSuperBowl?.status === "final" && !unresolved) {
      appendProviderResults(sql, String(season.id), [finalSuperBowl], causalObservedAt);
      sql.exec("UPDATE season SET state = 'closed', close_reason = 'super_bowl_final', closed_at = ? WHERE id = ?", iso(), season.id); sql.exec("UPDATE pool SET active_season_id = NULL WHERE active_season_id = ?", season.id); closed.push({ id: String(season.id), reason: "super_bowl_final" });
    }
  }
  return closed;
}
