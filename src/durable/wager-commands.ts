import { WHOLE_SHARE_MICROS, parseIntegerText } from "../domain/fixed-point";
import { adjustTeaserLine, validateTeaser } from "../domain/grading";
import { teaserOdds, TEASER_RULESET_ID } from "../domain/teaser-table";
import { CANONICAL_BOOK_POLICY_VERSION } from "../odds/types";
import { PARLAY_RULESET_ID, parlayOdds } from "../domain/parlay";
import type { TeaserLeg } from "../domain/types";
import type { PoolCommand } from "./pool-commands";

type Sql = { exec(query: string, ...params: SqlStorageValue[]): Iterable<Record<string, SqlStorageValue>> };
type Placement = Extract<PoolCommand, { type: "PlaceStraightWager" | "PlaceTeaserWager" | "PlaceParlayWager" }>;
type WagerLeg = Extract<Placement, { type: "PlaceStraightWager" }>["leg"] | Extract<Placement, { type: "PlaceTeaserWager" | "PlaceParlayWager" }>["legs"][number];
const first = (sql: Sql, query: string, ...params: SqlStorageValue[]) => [...sql.exec(query, ...params)][0];
const now = () => new Date().toISOString();
const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
const lcm = (a: bigint, b: bigint): bigint => a / gcd(a, b) * b;

/** Enforces each member's limit with exact fractional teaser exposure, never rounded shares. */
function assertSideBetLimit(sql: Sql, command: Placement, legs: WagerLeg[], maxSideBetMicros: bigint): void {
  const legCount = BigInt(legs.length);
  for (const leg of legs) {
    const prior = [...sql.exec("SELECT w.risk_micros, COUNT(all_legs.id) AS leg_count FROM wager w JOIN wager_leg matched ON matched.wager_id = w.id JOIN wager_leg all_legs ON all_legs.wager_id = w.id WHERE w.season_id = ? AND w.owner_id = ? AND w.status = 'open' AND matched.event_id = ? AND matched.market = ? AND matched.selection = ? GROUP BY w.id", command.seasonId, command.actorId, leg.eventId, leg.market, leg.selection)];
    const denominators = [legCount, ...prior.map((row) => BigInt(String(row.leg_count)))];
    const denominator = denominators.reduce(lcm, 1n);
    const existing = prior.reduce((total, row) => total + parseIntegerText(String(row.risk_micros)) * (denominator / BigInt(String(row.leg_count))), 0n);
    const proposed = parseIntegerText(command.riskMicros) * (denominator / legCount);
    if (existing + proposed > maxSideBetMicros * denominator) throw new Error("SIDE_BET_LIMIT");
  }
}

/** Locks whole shares and records every accepted provider/offer term before any result is available. */
export function placeWager(sql: Sql, command: Placement): { wagerId: string } {
  const risk = parseIntegerText(command.riskMicros);
  if (risk < WHOLE_SHARE_MICROS || risk % WHOLE_SHARE_MICROS !== 0n) throw new Error("WHOLE_SHARE_RISK_REQUIRED");
  const season = first(sql, "SELECT season.state, pool.max_side_bet_micros FROM season JOIN pool ON 1 = 1 WHERE season.id = ?", command.seasonId);
  if (!season) throw new Error("SEASON_NOT_ACTIVE");
  if (season.state === "closed") throw new Error("SEASON_CLOSED");
  if (season.state !== "active") throw new Error("SEASON_NOT_ACTIVE");
  const maxSideBetMicros = parseIntegerText(String(season.max_side_bet_micros));
  if (risk > maxSideBetMicros) throw new Error("SIDE_BET_LIMIT");
  const account = first(sql, "SELECT available_micros, locked_micros FROM share_account WHERE season_id = ? AND member_id = ?", command.seasonId, command.actorId);
  if (!account || parseIntegerText(String(account.available_micros)) < risk) throw new Error("INSUFFICIENT_SHARES");
  const legs = command.type === "PlaceStraightWager" ? [command.leg] : command.legs;
  if (legs.some((leg) => !["DraftKings", "FanDuel", "BetMGM", "Caesars"].includes(leg.canonicalBook) || leg.policyVersion !== CANONICAL_BOOK_POLICY_VERSION || leg.canonicalOfferProof.eventId !== leg.eventId || leg.canonicalOfferProof.offerVersion !== leg.offerVersion || leg.canonicalOfferProof.canonicalBook !== leg.canonicalBook || leg.canonicalOfferProof.market !== leg.market || leg.canonicalOfferProof.selection !== leg.selection || (leg.market !== "moneyline" && leg.canonicalOfferProof.odds !== leg.originalOdds) || leg.canonicalOfferProof.line !== leg.originalLine)) throw new Error("INVALID_OFFER_SNAPSHOT");
  if (command.type === "PlaceStraightWager") {
    const validSelection = command.leg.market === "total" ? ["over", "under"].includes(command.leg.selection) : ["home", "away"].includes(command.leg.selection);
    if (!validSelection || (command.leg.market === "moneyline" && (command.leg.originalLine !== null || command.leg.adjustedLine !== null || command.acceptedOdds !== command.leg.originalOdds)) || (command.leg.market !== "moneyline" && (command.leg.originalLine === null || command.leg.adjustedLine !== command.leg.originalLine || command.acceptedOdds !== 100))) throw new Error("INVALID_WAGER_LEG");
  } else if (command.type === "PlaceTeaserWager") {
    validateTeaser(legs.map((leg) => ({ eventId: leg.eventId, market: leg.market, selection: leg.selection, line: leg.originalLine } as TeaserLeg)), command.teaserPoints);
    if (command.rulesetVersion !== TEASER_RULESET_ID || teaserOdds(legs.length, command.teaserPoints) !== command.acceptedOdds || legs.some((leg) => adjustTeaserLine({ eventId: leg.eventId, market: leg.market, selection: leg.selection, line: leg.originalLine } as TeaserLeg, command.teaserPoints) !== (leg as Extract<Placement, { type: "PlaceTeaserWager" }>['legs'][number]).adjustedLine)) throw new Error("INVALID_TEASER_TERMS");
  } else {
    const derivedOdds = parlayOdds(legs);
    if (command.rulesetVersion !== PARLAY_RULESET_ID || derivedOdds !== command.acceptedOdds || legs.some((leg) => leg.adjustedLine !== leg.originalLine)) throw new Error("INVALID_PARLAY_TERMS");
  }
  if (legs.some((leg) => new Date(leg.eventStartsAt).getTime() <= Date.now())) throw new Error("MARKET_LOCKED");
  assertSideBetLimit(sql, command, legs, maxSideBetMicros);

  const confirmedAt = now();
  sql.exec("UPDATE share_account SET available_micros = ?, locked_micros = ?, row_version = row_version + 1 WHERE season_id = ? AND member_id = ?", (parseIntegerText(String(account.available_micros)) - risk).toString(), (parseIntegerText(String(account.locked_micros ?? "0")) + risk).toString(), command.seasonId, command.actorId);
  const wagerType = command.type === "PlaceStraightWager" ? "straight" : command.type === "PlaceTeaserWager" ? "teaser" : "parlay";
  sql.exec("INSERT INTO wager (id, season_id, owner_id, type, risk_micros, accepted_odds, status, ruleset_version, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)", command.wagerId, command.seasonId, command.actorId, wagerType, risk.toString(), command.acceptedOdds, command.rulesetVersion, confirmedAt);
  for (const [index, leg] of legs.entries()) {
    sql.exec(
      "INSERT INTO wager_leg (id, wager_id, event_id, league, canonical_book, retrieved_at, policy_version, offer_version, canonical_offer_id, canonical_proof_json, market, selection, original_line, original_odds, teaser_adjustment, adjusted_line, event_starts_at, is_super_bowl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      `${command.wagerId}:${index}`, command.wagerId, leg.eventId, leg.league, leg.canonicalBook, leg.retrievedAt, leg.policyVersion, leg.offerVersion, leg.canonicalOfferProof.offerId, JSON.stringify(leg.canonicalOfferProof), leg.market, leg.selection, leg.originalLine === null ? null : String(leg.originalLine), leg.originalOdds, command.type === "PlaceTeaserWager" ? String(command.teaserPoints) : null, command.type === "PlaceTeaserWager" ? String((leg as Extract<Placement, { type: "PlaceTeaserWager" }>['legs'][number]).adjustedLine) : null, leg.eventStartsAt, 0
    );
    if (leg.homeTeam && leg.awayTeam) sql.exec("INSERT INTO wager_leg_snapshot (wager_leg_id, home_team, away_team) VALUES (?, ?, ?)", `${command.wagerId}:${index}`, leg.homeTeam, leg.awayTeam);
    // Result coverage starts at the accepted event's kickoff, never at wager placement.
    sql.exec("INSERT OR IGNORE INTO event_reconciliation (event_id, event_starts_at, phase, attempts, error_attempts, next_attempt_at) VALUES (?, ?, 'open', 0, 0, ?)", leg.eventId, leg.eventStartsAt, leg.eventStartsAt);
  }
  sql.exec("INSERT INTO ledger_entry (id, season_id, member_id, actor_id, available_delta, locked_delta, float_delta, notional_delta, causation_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, '0', '0', ?, 'wager_lock', ?)", `ledger:lock:${command.wagerId}`, command.seasonId, command.actorId, command.actorId, (-risk).toString(), risk.toString(), command.wagerId, confirmedAt);
  return { wagerId: command.wagerId };
}
