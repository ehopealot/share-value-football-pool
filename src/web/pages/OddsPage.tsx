import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, buildStraightPlacement, commandOutcome, errorMessage } from "../api";
import { vigFreeMoneylinePrice } from "../../odds/market-semantics";
import { Layout } from "../components/Layout";
import { selectableOutcomes, selectionForOutcome } from "../selection-matcher";
import { addTeaserLeg, teaserLegForOutcome, writeTeaserSlip } from "../teaser-slip";
import { buildParlaySlip, writeParlaySlip } from "../parlay-slip";
import { readSelectionTray, resolveTrayItem, straightBatchRiskError, teaserEligible, toggleMarketExclusive, writeSelectionTray, type TrayItem } from "../selection-tray";
import { formatMicros, parseIntegerText } from "../../domain/fixed-point";
import { formatAmericanOdds, formatKickoff, formatSignedLine } from "../odds-format";
import { ticketReturns } from "../wager-presentation";
import { formatCurrentShareValue } from "../share-value";
import { PageGeneration } from "../page-generation";
import { inWeek, nextWeekStart, SEASON_WEEK1_ANCHOR, weekNumberLabel, weekStartOf } from "../../domain/betting-week";
export { inWeek, nextWeekStart, SEASON_WEEK1_ANCHOR, weekNumberLabel, weekStartOf } from "../../domain/betting-week";
export type BoardPick = { offer: any; outcome: any };
/** Review controls follow the parsed fail-closed board state, never retained editor data. */
export const boardEnablesWagerReview = (board: { offers?: unknown[]; feed?: { status?: string } } | undefined): boolean => board?.feed?.status === "current" && !!board.offers?.length;

export type MarketCell = { offer: any; outcome: any; label: string; selection: string; name: string; odds: string };
export type GameMarkets = { spread: { away?: MarketCell; home?: MarketCell }; total: { over?: MarketCell; under?: MarketCell }; moneyline: { away?: MarketCell; home?: MarketCell } };
export type GameRow = { eventId: string; startsAt: string; awayTeam: string; homeTeam: string; markets: GameMarkets };
const pickId = (item: Pick<TrayItem, "eventId" | "market" | "selection">) => `${item.eventId}:${item.market}:${item.selection}`;
export type OddsBoardTableProps = { games: GameRow[]; currentWeek: string; selectedPickIds: string[]; selectionDisabled?: boolean; onToggle: (cell: MarketCell) => void };
const samePickIds = (left: string[], right: string[]) => left.length === right.length && left.every((id, index) => id === right[index]);
/** Risk edits must not reconcile a whole odds table; only changed selections affect its cells. */
export const oddsBoardTablePropsAreEqual = (previous: OddsBoardTableProps, next: OddsBoardTableProps) => previous.games === next.games && previous.currentWeek === next.currentWeek && previous.selectionDisabled === next.selectionDisabled && previous.onToggle === next.onToggle && samePickIds(previous.selectedPickIds, next.selectedPickIds);
export const OddsBoardTable = memo(function OddsBoardTable({ games, currentWeek, selectedPickIds, selectionDisabled = false, onToggle }: OddsBoardTableProps) {
  const selected = new Set(selectedPickIds);
  return <div className="table-scroll" tabIndex={0}><table className="odds-board"><caption>Current odds</caption><thead><tr><th scope="col">Start</th><th scope="col">Matchup</th><th scope="col">Spread</th><th scope="col">Total</th><th scope="col">Moneyline</th></tr></thead><tbody>{games.flatMap((game) => {
    const top: Array<MarketCell | undefined> = [game.markets.spread.away, game.markets.total.over, game.markets.moneyline.away];
    const bottom: Array<MarketCell | undefined> = [game.markets.spread.home, game.markets.total.under, game.markets.moneyline.home];
    const cell = (option: MarketCell | undefined, index: number) => {
      // Only the current Tuesday–Monday week is bettable; future weeks are visible but locked.
      const locked = !inWeek(game.startsAt, currentWeek);
      const classes = ["odds-option", locked ? "locked" : "", option?.offer.market === "total" ? "odds-option-total" : ""].filter(Boolean).join(" ");
      return option ? <td className="odds-cell" key={`${game.eventId}-${index}-${option.selection}`}><label className={classes}><input type="checkbox" disabled={locked || selectionDisabled} checked={selected.has(pickId({ eventId: option.offer.eventId, market: option.offer.market, selection: option.selection as TrayItem["selection"] }))} onChange={() => onToggle(option)} /><span className="odds-option-name">{option.name}</span><strong>{option.odds}</strong></label></td> : <td className="odds-cell odds-empty" key={`${game.eventId}-${index}-empty`} />;
    };
    const kickoff = formatKickoff(game.startsAt);
    return [<tr key={`${game.eventId}-top`} className="odds-game-top"><td rowSpan={2} className="odds-start">{kickoff}</td><th scope="row" rowSpan={2} className="odds-matchup"><span>{game.awayTeam}</span><span>{game.homeTeam}</span><small className="odds-mobile-start">{kickoff}</small></th>{top.map(cell)}</tr>, <tr key={`${game.eventId}-bottom`} className="odds-game-bottom">{bottom.map(cell)}</tr>];
  })}</tbody></table></div>;
}, oddsBoardTablePropsAreEqual);
/** Compact board grouping: a two-row game block — away/Over on top, home/Under underneath, one market per column. */
export function groupBoardByEvent(offers: any[]): GameRow[] {
  const rows = new Map<string, GameRow>();
  for (const offer of [...offers].sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)) || String(a.eventId).localeCompare(String(b.eventId)))) {
    if (!rows.has(offer.eventId)) rows.set(offer.eventId, { eventId: offer.eventId, startsAt: offer.startsAt, awayTeam: offer.awayTeam, homeTeam: offer.homeTeam, markets: { spread: {}, total: {}, moneyline: {} } });
    const game = rows.get(offer.eventId)!;
    for (const outcome of selectableOutcomes(offer) as any[]) {
      const selection = selectionForOutcome(offer, outcome);
      if (!selection) continue;
      const name = offer.market === "total" ? (selection === "over" ? "O" : "U") : outcome.name;
      const odds = offer.market === "total" ? `${outcome.point}` : offer.market === "moneyline" ? formatAmericanOdds(outcome.price) : formatSignedLine(outcome.point ?? outcome.price);
      const cell: MarketCell = { offer, outcome, selection, name, odds, label: `${name} ${odds}` };
      if (offer.market === "spread" && (selection === "away" || selection === "home")) game.markets.spread[selection] = cell;
      if (offer.market === "total" && (selection === "over" || selection === "under")) game.markets.total[selection] = cell;
      if (offer.market === "moneyline" && (selection === "away" || selection === "home")) game.markets.moneyline[selection] = cell;
    }
  }
  for (const game of rows.values()) {
    // The moneyline column displays the shared vig-free strike; tickets still retain raw source proof separately.
    const away = game.markets.moneyline.away; const home = game.markets.moneyline.home;
    const awayPrice = away && vigFreeMoneylinePrice({ homeTeam: game.homeTeam, awayTeam: game.awayTeam }, away.offer.outcomes, "away");
    const homePrice = home && vigFreeMoneylinePrice({ homeTeam: game.homeTeam, awayTeam: game.awayTeam }, home.offer.outcomes, "home");
    if (away && awayPrice !== undefined) game.markets.moneyline.away = { ...away, odds: formatAmericanOdds(awayPrice), label: `${away.outcome.name} ${formatAmericanOdds(awayPrice)}` };
    if (home && homePrice !== undefined) game.markets.moneyline.home = { ...home, odds: formatAmericanOdds(homePrice), label: `${home.outcome.name} ${formatAmericanOdds(homePrice)}` };
  }
  return [...rows.values()];
}

const normalizeTeamFilter = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const maxTeamTypoDistance = (token: string) => token.length >= 7 ? 2 : token.length >= 3 ? 1 : 0;
const hasBoundedTypo = (query: string, candidate: string, maximum: number) => {
  if (Math.abs(query.length - candidate.length) > maximum) return false;
  let previous = Array.from({ length: candidate.length + 1 }, (_, index) => index);
  let twoRowsBack: number[] | undefined;
  for (let row = 1; row <= query.length; row++) {
    const current = [row];
    let lowest = row;
    for (let column = 1; column <= candidate.length; column++) {
      const substitution = previous[column - 1] + (query[row - 1] === candidate[column - 1] ? 0 : 1);
      const insertion = current[column - 1] + 1;
      const deletion = previous[column] + 1;
      const transposition = twoRowsBack && column > 1 && query[row - 1] === candidate[column - 2] && query[row - 2] === candidate[column - 1] ? twoRowsBack[column - 2] + 1 : Number.POSITIVE_INFINITY;
      current[column] = Math.min(substitution, insertion, deletion, transposition);
      lowest = Math.min(lowest, current[column]);
    }
    if (lowest > maximum) return false;
    twoRowsBack = previous;
    previous = current;
  }
  return previous[candidate.length] <= maximum;
};
const teamMatchesFilter = (teamName: string, terms: string[]) => {
  const normalized = normalizeTeamFilter(teamName);
  const tokens = normalized.split(" ").filter(Boolean);
  return terms.every((term) => tokens.some((token) => token.includes(term) || hasBoundedTypo(term, token, maxTeamTypoDistance(term))));
};
/** Filters only the rendered game rows; input order remains the kickoff order from groupBoardByEvent. */
export const filterGamesByTeam = (games: GameRow[], filter: string): GameRow[] => {
  const terms = normalizeTeamFilter(filter).split(" ").filter(Boolean);
  return terms.length === 0 ? games : games.filter((game) => teamMatchesFilter(game.awayTeam, terms) || teamMatchesFilter(game.homeTeam, terms));
};

/** Builds the single-leg straight quote request for one tray item against its resolved pick. */
export function straightQuoteRequest(semantic: { pick: BoardPick; risk: string; wagerId: string; quoteKey: string }, seasonId: string) {
  const { offer } = semantic.pick; const selection = selectionForOutcome(offer, semantic.pick.outcome);
  if (!selection) throw new Error("CURRENT_OFFER_UNAVAILABLE");
  return { wagerId: semantic.wagerId, seasonId, riskMicros: (BigInt(semantic.risk) * 1000000n).toString(), rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: offer.eventId, canonicalBook: offer.canonicalBook, market: offer.market, selection, offerId: `${offer.eventId}:${offer.market}:${selection}`, offerVersion: offer.offerVersion }, quoteKey: semantic.quoteKey, commandId: semantic.quoteKey };
}

/** Batch item failures name the reason and keep the item retryable after its safe automatic status replays. */
export const failureReason = (error: unknown, phase: "quote" | "place", maxSideBetMicros?: string): string =>
  error instanceof ApiError && error.code === "SIDE_BET_LIMIT" && maxSideBetMicros ? `Max bet: ${(BigInt(maxSideBetMicros) / 1000000n).toString()} shares.`
    : commandOutcome(error) === "stale" ? "Line changed."
      : commandOutcome(error) === "retryable" && phase === "place" ? "Placement result unknown."
        : commandOutcome(error) === "retryable" ? "Odds unavailable."
          : errorMessage(error);

type FailedEntry = { label: string; reason: string };
type ReviewEntry = { item: TrayItem; pick: BoardPick; quote: any; mutationKey: string; label: string };
export const straightReviewDetails = (entry: Pick<ReviewEntry, "item" | "quote">) => {
  const leg = entry.quote.leg;
  const selection = leg.market === "total" ? leg.selection === "over" ? "Over" : "Under" : leg.selection === "away" ? leg.awayTeam ?? "Away" : leg.homeTeam ?? "Home";
  const market = `${String(leg.market).slice(0, 1).toUpperCase()}${String(leg.market).slice(1)}`;
  const line = leg.market === "moneyline" || leg.originalLine === null || leg.originalLine === undefined ? "" : ` ${leg.market === "total" ? Number(leg.originalLine) : formatSignedLine(Number(leg.originalLine))}`;
  return { matchup: `${leg.awayTeam ?? "Away"} at ${leg.homeTeam ?? "Home"}`, pick: `${market} — ${selection}${line}`, odds: formatAmericanOdds(entry.quote.acceptedOdds), risk: `${entry.item.risk} shares`, toWin: `${ticketReturns(entry.quote.riskMicros, entry.quote.acceptedOdds).profit} shares` };
};
type StraightReviewBatch = { entries: ReviewEntry[]; quoteFailures: FailedEntry[]; placed: string[]; failed: FailedEntry[] };
type StraightPlacementResult = { placed: ReviewEntry[]; failed: Array<FailedEntry & { entry: ReviewEntry }>; retry: ReviewEntry[] };
type Batch = { tag: "quoting" } | ({ tag: "reviewing" | "placing" } & StraightReviewBatch) | { tag: "results"; placed: string[]; failed: FailedEntry[]; retryPlacements: ReviewEntry[] };
/** The review-history entry is transient UI state, including its post-placement results. */
export const batchAfterPopState = (current: Batch | undefined): Batch | undefined => current?.tag === "reviewing" || current?.tag === "results" ? undefined : current;
/** Preserves known outcomes while only unresolved frozen placements remain available for manual recovery. */
export const straightPlacementBatchTransition = (reviewing: StraightReviewBatch, result: StraightPlacementResult): Batch => {
  const placed = [...reviewing.placed, ...result.placed.map((entry) => entry.label)];
  const failed = [...reviewing.failed, ...result.failed.map(({ label, reason }) => ({ label, reason }))];
  return result.retry.length > 0
    ? { tag: "reviewing", entries: result.retry, quoteFailures: reviewing.quoteFailures, placed, failed }
    : { tag: "results", placed, failed, retryPlacements: [] };
};
const placeEntries = async (slug: string, entries: ReviewEntry[], maxSideBetMicros?: string): Promise<StraightPlacementResult> => {
  const placed: ReviewEntry[] = []; const failed: Array<FailedEntry & { entry: ReviewEntry }> = []; const retry: ReviewEntry[] = [];
  for (const entry of entries) {
    try { await api.placeWager(slug, "/wagers/straight/place", buildStraightPlacement(entry.quote, entry.item.wagerId, entry.mutationKey)); placed.push(entry); }
    catch (e) {
      const outcome = commandOutcome(e);
      // The API exhausted its safe replays of this exact frozen placement; retain it for manual recovery.
      if (outcome === "retryable") retry.push(entry);
      else failed.push({ label: entry.label, reason: failureReason(e, "place", maxSideBetMicros), entry });
    }
  }
  return { placed, failed, retry };
};
const displayedBoardValue = (offer: any, outcome: any, selection: TrayItem["selection"]) => {
  if (offer.market === "total") return `${outcome.point}`;
  if (offer.market === "moneyline") {
    const price = Array.isArray(offer.outcomes) && (selection === "home" || selection === "away")
      ? vigFreeMoneylinePrice({ homeTeam: offer.homeTeam, awayTeam: offer.awayTeam }, offer.outcomes, selection)
      : undefined;
    return formatAmericanOdds(price ?? outcome.price);
  }
  return formatSignedLine(outcome.point ?? outcome.price);
};
/** Tray labels mirror the board's current selected price; raw source values remain immutable quote proof only. */
export const trayLabel = (board: { offers?: any[] }, item: TrayItem, resolved: { offer: any; outcome: any } | undefined): string => {
  if (!resolved) return `${item.market} ${item.selection} (no longer available)`;
  const offer = board.offers?.find((candidate) => candidate.eventId === item.eventId && candidate.market === item.market) ?? resolved.offer;
  return `${resolved.offer.awayTeam} at ${resolved.offer.homeTeam}: ${item.market} — ${resolved.outcome.name} ${displayedBoardValue(offer, resolved.outcome, item.selection)}`;
};
/** Market type is implicit in a live pick's team, total, or price display. */
export const selectionTrayDisplayLabel = (item: TrayItem, resolved: { offer: any; outcome: any } | undefined): string => resolved ? `${resolved.offer.awayTeam} at ${resolved.offer.homeTeam}: ${resolved.outcome.name} ${displayedBoardValue(resolved.offer, resolved.outcome, item.selection)}` : trayLabel({}, item, resolved);
/** Transfers the first six eligible legs and returns every untransferred tray item for persistence. */
export const buildTeaserTransfer = (items: TrayItem[], board: { offers?: any[] }) => {
  let slip: ReturnType<typeof teaserLegForOutcome>[] = []; let error = ""; const added: TrayItem[] = [];
  for (const item of items) {
    if (!teaserEligible(item)) continue;
    const resolved = resolveTrayItem(board, item);
    if (!resolved || typeof resolved.outcome.point !== "number") continue;
    const next = addTeaserLeg(slip, teaserLegForOutcome(resolved.offer, resolved.outcome, item.selection));
    if (next.error) { error ||= next.error; continue; }
    slip = next.legs; added.push(item);
  }
  const addedIds = new Set(added.map(pickId));
  return { slip, remaining: items.filter((item) => !addedIds.has(pickId(item))), error };
};

/** Resolves cross-filter tray selections against one fresh, unfiltered board snapshot. */
export const buildCurrentParlayTransfer = async (
  slug: string,
  items: TrayItem[],
  load: (slug: string, query?: string) => Promise<{ offers?: any[] }> = api.odds
) => buildParlaySlip(items, await load(slug));

type ParlayTrayTransferTicket = { id: number; slug: string; identities: string[] };
const sameTrayIdentities = (left: readonly string[], right: TrayItem[]) => left.length === right.length && left.every((identity, index) => identity === pickId(right[index]!));
/** A single in-flight transfer may commit only the exact tray identity it resolved. */
export class ParlayTrayTransferGate {
  private next = 0;
  private active?: ParlayTrayTransferTicket;
  get pending(): boolean { return this.active !== undefined; }
  begin(slug: string, items: TrayItem[]): ParlayTrayTransferTicket | undefined {
    if (this.active) return undefined;
    const ticket = { id: ++this.next, slug, identities: items.map(pickId) };
    this.active = ticket;
    return ticket;
  }
  matches(ticket: ParlayTrayTransferTicket, slug: string, items: TrayItem[]): boolean {
    return this.active?.id === ticket.id && ticket.slug === slug && sameTrayIdentities(ticket.identities, items);
  }
  finish(ticket: ParlayTrayTransferTicket): boolean {
    if (this.active?.id !== ticket.id) return false;
    this.active = undefined;
    return true;
  }
  cancel(): void { this.active = undefined; }
}
export const parlayTrayChangedMessage = "Your parlay selections changed while current odds loaded. Review and retry Build parlay.";
export const parlayTransferUnavailableMessage = "Current odds are unavailable; your parlay selections were not moved.";
type ParlayTrayTransferResult =
  | { tag: "ready"; transfer: Awaited<ReturnType<typeof buildCurrentParlayTransfer>> }
  | { tag: "already-pending" }
  | { tag: "tray-changed" }
  | { tag: "load-failed" }
  | { tag: "cancelled" };
/** Fetches an unfiltered board without permitting a stale tray snapshot to mutate either slip. */
export const runParlayTrayTransfer = async ({ gate, slug, items, load = api.odds, currentItems, currentSlug, isCurrent = () => true, onPending, onReady }: {
  gate: ParlayTrayTransferGate;
  slug: string;
  items: TrayItem[];
  load?: (slug: string, query?: string) => Promise<{ offers?: any[] }>;
  currentItems: () => TrayItem[];
  currentSlug: () => string;
  isCurrent?: () => boolean;
  onPending?: (pending: boolean) => void;
  onReady?: (transfer: Awaited<ReturnType<typeof buildCurrentParlayTransfer>>) => void;
}): Promise<ParlayTrayTransferResult> => {
  const ticket = gate.begin(slug, items);
  if (!ticket) return { tag: "already-pending" };
  onPending?.(true);
  try {
    let transfer: Awaited<ReturnType<typeof buildCurrentParlayTransfer>>;
    try { transfer = await buildCurrentParlayTransfer(slug, items, load); }
    catch {
      if (!isCurrent()) return { tag: "cancelled" };
      return gate.matches(ticket, currentSlug(), currentItems()) ? { tag: "load-failed" } : { tag: "tray-changed" };
    }
    if (!isCurrent()) return { tag: "cancelled" };
    if (!gate.matches(ticket, currentSlug(), currentItems())) return { tag: "tray-changed" };
    onReady?.(transfer);
    return { tag: "ready", transfer };
  } finally {
    // Only the ticket that is still active may mark the pending UI idle.
    if (gate.finish(ticket)) onPending?.(false);
  }
};

export function OddsPage() {
  const { slug = "" } = useParams(); const nav = useNavigate(); const [board, setBoard] = useState<any>(); const [view, setView] = useState<any>();
  const [league, setLeague] = useState(""); const [selectedWeek, setSelectedWeek] = useState(""); const [teamFilter, setTeamFilter] = useState("");
  const [tray, setTray] = useState<TrayItem[]>([]); const [batch, setBatch] = useState<Batch>(); const [notice, setNotice] = useState(""); const [parlayTransferPending, setParlayTransferPending] = useState(false);
  const [error, setError] = useState(""); const errorRef = useRef<HTMLParagraphElement>(null); const trayRef = useRef<TrayItem[]>([]); const slugRef = useRef(slug); const pageGenerations = useRef(new PageGeneration()); const parlayTransfer = useRef(new ParlayTrayTransferGate()); const parlayTransferGeneration = useRef(0); slugRef.current = slug;
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const query = `?${new URLSearchParams(Object.fromEntries([["league", league]].filter(([, value]) => value)))}`;
  useEffect(() => { let active = true; void api.odds(slug, query).then((fresh) => { if (active) setBoard(fresh); }).catch(e => { if (active) setError(errorMessage(e)); }); return () => { active = false; }; }, [slug, query]);
  useEffect(() => {
    const ticket = pageGenerations.current.start(slug);
    const generation = ++parlayTransferGeneration.current;
    parlayTransfer.current.cancel(); setParlayTransferPending(false); setBatch(undefined); setView(undefined); setError(""); setNotice("");
    const restored = readSelectionTray(slug); trayRef.current = restored; setTray(restored);
    void api.poolView(slug).then((loaded) => { if (pageGenerations.current.current(ticket)) setView(loaded); }).catch((e) => { if (pageGenerations.current.current(ticket)) setError(errorMessage(e)); });
    return () => {
      pageGenerations.current.invalidate(ticket);
      if (parlayTransferGeneration.current !== generation) return;
      parlayTransferGeneration.current++;
      parlayTransfer.current.cancel();
    };
  }, [slug]);
  const persist = (next: TrayItem[]) => { trayRef.current = next; writeSelectionTray(slug, next); setTray(next); };
  useEffect(() => { const backToBoard = () => setBatch(batchAfterPopState); window.addEventListener("popstate", backToBoard); return () => window.removeEventListener("popstate", backToBoard); }, []);
  const removeItem = (items: TrayItem[], item: TrayItem) => items.filter((candidate) => !(candidate.eventId === item.eventId && candidate.market === item.market && candidate.selection === item.selection));
  const pending = batch?.tag === "quoting" || batch?.tag === "placing";
  const currentWeek = weekStartOf(new Date()).toISOString();
  // Eastern-week calculation is expensive for a full board; it changes only when its data or week changes, never while a risk field is edited.
  const weekOptions = useMemo(() => {
    const seasonWeeks: string[] = [];
    for (let cursor = new Date(SEASON_WEEK1_ANCHOR), latest = weekStartOf(new Date()); cursor <= latest; cursor = nextWeekStart(cursor)) seasonWeeks.push(cursor.toISOString());
    return [...new Set<string>([...seasonWeeks, ...(board?.offers ?? []).map((offer: any) => weekStartOf(new Date(offer.startsAt)).toISOString())])].sort();
  }, [board, currentWeek]);
  // Default to the earliest week with games (future weeks count); the current week is the fallback.
  const week = useMemo(() => selectedWeek || weekOptions.find((option) => (board?.offers ?? []).some((offer: any) => inWeek(offer.startsAt, option))) || currentWeek, [board, currentWeek, selectedWeek, weekOptions]);
  const weekGames = useMemo(() => groupBoardByEvent((board?.offers ?? []).filter((offer: any) => !week || inWeek(offer.startsAt, week))), [board, week]);
  // Team filtering only changes the rendered rows; risk edits retain this memoized game list.
  const games = useMemo(() => filterGamesByTeam(weekGames, teamFilter), [weekGames, teamFilter]);
  const selectedPickIds = tray.map(pickId);
  const toggle = useCallback((cell: MarketCell) => {
    if (parlayTransfer.current.pending) return;
    setTray((current) => {
      const next = toggleMarketExclusive(current, { eventId: cell.offer.eventId, market: cell.offer.market, selection: cell.selection, wagerId: crypto.randomUUID(), risk: "" } as TrayItem);
      trayRef.current = next;
      writeSelectionTray(slug, next);
      return next;
    });
  }, [slug]);
  // Teasers need at least two legs, so the builder stays disabled for single-game slips.
  const teaserEligibleCount = tray.filter((item) => teaserEligible(item) && resolveTrayItem(board ?? {}, item) && typeof resolveTrayItem(board ?? {}, item)!.outcome.point === "number").length;
  const balance = view?.activeSeason && view.currentMember.seasonBalances.find((item: any) => item.seasonId === view.activeSeason.id);
  const riskError = straightBatchRiskError(tray, { maxSideBetMicros: view?.pool.maxSideBetMicros, availableMicros: balance?.availableMicros });
  const available = balance ? parseIntegerText(balance.availableMicros) : 0n;
  const total = balance ? available + parseIntegerText(balance.lockedMicros) : 0n;
  const shareValue = view?.activeSeason ? formatCurrentShareValue(view.activeSeason.floatMicros, view.activeSeason.notionalValueMicros) : "$0.00";
  const noIssuedShares = !view?.activeSeason || parseIntegerText(view.activeSeason.floatMicros) === 0n;

  const quoteAll = async () => {
    if (parlayTransfer.current.pending) return;
    const ticket = pageGenerations.current.capture(slug); if (!ticket) return;
    const riskError = straightBatchRiskError(tray, { maxSideBetMicros: view?.pool.maxSideBetMicros, availableMicros: balance?.availableMicros }); if (riskError) return setError(riskError);
    if (!view?.activeSeason?.id) return setError("Open an active season before reviewing wagers.");
    setNotice(""); setError("");
    setBatch({ tag: "quoting" });
    // Always quote against a freshly fetched board so a retry after a line change cannot reuse stale authority.
    const fresh = await api.odds(slug, query).catch(() => undefined);
    if (!pageGenerations.current.current(ticket)) return;
    if (fresh) setBoard(fresh);
    const current = fresh ?? board;
    const entries: ReviewEntry[] = []; const failures: FailedEntry[] = []; let nextTray = [...tray];
    for (const item of tray) {
      const resolved = resolveTrayItem(current, item);
      const label = trayLabel(board ?? {}, item, resolved);
      if (!resolved) { failures.push({ label, reason: "This selection is no longer available on the board." }); nextTray = removeItem(nextTray, item); continue; }
      try {
        const quote = await api.quoteStraight(slug, straightQuoteRequest({ pick: resolved, risk: item.risk, wagerId: item.wagerId, quoteKey: crypto.randomUUID() }, view.activeSeason.id));
        if (!pageGenerations.current.current(ticket)) return;
        entries.push({ item, pick: resolved, quote, mutationKey: crypto.randomUUID(), label });
      } catch (e) {
        if (!pageGenerations.current.current(ticket)) return;
        failures.push({ label, reason: failureReason(e, "quote", view.pool.maxSideBetMicros) });
      }
    }
    if (!pageGenerations.current.current(ticket)) return;
    persist(nextTray);
    if (entries.length) window.history.pushState({ ...(window.history.state ?? {}), sharePoolBetReview: true }, "", window.location.href);
    setBatch(entries.length ? { tag: "reviewing", entries, quoteFailures: failures, placed: [], failed: [] } : { tag: "results", placed: [], failed: failures, retryPlacements: [] });
  };

  const placeAll = async (reviewing: StraightReviewBatch) => {
    const ticket = pageGenerations.current.capture(slug); if (!ticket) return;
    setError(""); setBatch({ ...reviewing, tag: "placing" });
    const result = await placeEntries(slug, reviewing.entries, view?.pool.maxSideBetMicros);
    if (!pageGenerations.current.current(ticket)) return;
    persist(tray.filter((item) => !result.placed.some((entry) => entry.item.eventId === item.eventId && entry.item.market === item.market && entry.item.selection === item.selection)));
    const transition = straightPlacementBatchTransition(reviewing, result);
    if (transition.tag === "reviewing") {
      // Only unresolved outcomes remain after automatic replays; known results stay visible beside the frozen retry.
      setBatch(transition);
      setError("Placement result unknown.");
      return;
    }
    setBatch(transition);
    void api.odds(slug, query).then((fresh) => { if (pageGenerations.current.current(ticket)) setBoard(fresh); }).catch(() => undefined);
  };

  const addEligibleToTeaser = () => {
    if (parlayTransfer.current.pending) return;
    // Build a fresh teaser from this slip; a prior draft must never affect these selections.
    const transfer = buildTeaserTransfer(tray, board ?? {});
    writeTeaserSlip(slug, transfer.slip);
    persist(transfer.remaining);
    setError(transfer.error);
    if (transfer.slip.length > 0) return nav(`/p/${slug}/teaser`);
    setNotice("");
  };

  const addToParlay = async () => {
    // The tray can span league filters; only this exact captured identity and mounted page generation may commit.
    const items = [...trayRef.current]; const generation = parlayTransferGeneration.current;
    const isCurrent = () => parlayTransferGeneration.current === generation && slugRef.current === slug;
    const result = await runParlayTrayTransfer({
      gate: parlayTransfer.current, slug, items, currentItems: () => trayRef.current, currentSlug: () => slugRef.current, isCurrent, onPending: setParlayTransferPending,
      onReady: (transfer) => {
        if (transfer.error) return setError(transfer.error);
        writeParlaySlip(slug, transfer.legs);
        persist([]);
        setError("");
        nav(`/p/${slug}/parlay`);
      }
    });
    if (!isCurrent() || result.tag === "already-pending" || result.tag === "cancelled" || result.tag === "ready") return;
    if (result.tag === "tray-changed") return setError(parlayTrayChangedMessage);
    return setError(parlayTransferUnavailableMessage);
  };

  const backToBoard = () => window.history.state?.sharePoolBetReview ? window.history.back() : setBatch(undefined);

  if (batch?.tag === "reviewing" || batch?.tag === "placing") {
    const entries = batch.entries;
    return <Layout signedIn><h1>Review straight wagers</h1><p role="status">{batch.tag === "placing" ? "Placing wagers…" : `${entries.length} straight wager${entries.length === 1 ? "" : "s"} ready to place.`}{batch.quoteFailures.length ? ` ${batch.quoteFailures.length} selection${batch.quoteFailures.length === 1 ? "" : "s"} could not be quoted and remain in your tray.` : ""}</p>
      <div className="table-scroll" tabIndex={0}><table><caption>Bet confirmation</caption><thead><tr><th>Matchup</th><th>Pick</th><th>Odds</th><th>Risk</th><th>To win</th></tr></thead><tbody>{entries.map((entry) => { const details = straightReviewDetails(entry); return <tr key={entry.item.wagerId}><td>{details.matchup}</td><td>{details.pick}</td><td>{details.odds}</td><td>{details.risk}</td><td>{details.toWin}</td></tr>; })}</tbody></table></div>
      <span className="tray-actions"><button className="primary-action" disabled={batch.tag === "placing"} onClick={() => void placeAll(batch)}>{batch.tag === "placing" ? "Placing…" : `Place ${entries.length} wager${entries.length === 1 ? "" : "s"}`}</button>
      <button disabled={batch.tag === "placing"} onClick={backToBoard}>Back to board</button></span>
      {batch.placed.length > 0 && <section aria-label="Placed wagers"><h2>Placed</h2><ul>{batch.placed.map((label) => <li key={label}>{label}</li>)}</ul></section>}
      {batch.failed.length > 0 && <section aria-label="Failed wagers"><h2>Not placed</h2><ul>{batch.failed.map((failure, index) => <li key={`${failure.label}-${index}`} role="alert">{failure.label} — {failure.reason}</li>)}</ul></section>}
      {error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}</Layout>;
  }
  if (batch?.tag === "results") {
    const total = batch.placed.length + batch.failed.length;
    return <Layout signedIn><h1>Placement results</h1><p role="status">{batch.placed.length} of {total} wager{total === 1 ? "" : "s"} placed. <Link to={`/p/${slug}/my-wagers`}>My wagers</Link></p>
      {batch.placed.length > 0 && <section aria-label="Placed wagers"><h2>Placed</h2><ul>{batch.placed.map((label) => <li key={label}>{label}</li>)}</ul></section>}
      {batch.failed.length > 0 && <section aria-label="Failed wagers"><h2>Not placed</h2><ul>{batch.failed.map((failure, index) => <li key={`${failure.label}-${index}`} role="alert">{failure.label} — {failure.reason}</li>)}</ul></section>}
      <button className="primary-action" onClick={backToBoard}>Back to odds board</button></Layout>;
  }
  if (batch?.tag === "quoting") return <Layout signedIn><h1>Reviewing straight wagers</h1><p role="status">Confirming odds for {tray.length} selection{tray.length === 1 ? "" : "s"}…</p></Layout>;

  return <Layout signedIn><h1>Odds board</h1><p className="pool-context">{view && <><Link to={`/p/${slug}/overview`}>{view.pool.name}</Link>{view.activeSeason ? ` · ${view.activeSeason.label}` : ""} · </>}<span role="status">Board status: {board?.feed.status ?? "loading"}</span>{board?.feed.status === "stale" && <> <a href={window.location.href}>Reload odds</a></>}</p>
    {error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="odds-board-filters"><label>League <select value={league} onChange={e => setLeague(e.target.value)}><option value="">All football</option><option value="nfl">NFL</option><option value="ncaaf">NCAA football</option></select></label>
    <label>Week <select value={week} onChange={e => setSelectedWeek(e.target.value)}>{weekOptions.map((option) => <option key={option} value={option}>{weekNumberLabel(option)}{option === currentWeek ? " (current)" : ""}</option>)}</select></label>
    <label>Filter teams <input type="search" value={teamFilter} placeholder="Search team names" onChange={e => setTeamFilter(e.target.value)} /></label></div>
    <OddsBoardTable games={games} currentWeek={currentWeek} selectedPickIds={selectedPickIds} selectionDisabled={parlayTransferPending} onToggle={toggle}/>
    {board && games.length === 0 && <p>{teamFilter.trim() ? "No teams match this filter." : "No games to show for this week."}</p>}
    <section aria-label="Selection tray" className="selection-tray"><h2>Bet slip</h2>{view?.activeSeason && <><p className="pool-balance">Shares: <strong>{formatMicros(total, 2)}</strong> · Available: <strong>{formatMicros(available, 2)}</strong> · Share price: <strong>{shareValue}</strong></p>{noIssuedShares && <p className="pool-context">No shares issued yet. First order price is $1.00 per share.</p>}</>}
      {tray.length > 0 && <><ul className="selection-tray-list">{tray.map((item) => { const resolved = resolveTrayItem(board ?? {}, item); const label = trayLabel(board ?? {}, item, resolved); const displayLabel = selectionTrayDisplayLabel(item, resolved); return <li key={pickId(item)}>{resolved ? <span className="tray-item-label">{displayLabel}</span> : <em className="tray-item-label">{displayLabel}</em>}<span className="selection-tray-amount"><input disabled={parlayTransferPending} type="number" min="1" step="1" value={item.risk} aria-label={`Risk in whole shares for ${label}`} onChange={e => { if (!parlayTransfer.current.pending) persist(tray.map((candidate) => pickId(candidate) === pickId(item) ? { ...candidate, risk: e.target.value } : candidate)); }} /></span><button disabled={parlayTransferPending} className="selection-tray-remove" onClick={() => { if (!parlayTransfer.current.pending) persist(removeItem(tray, item)); }}>Remove</button></li>; })}</ul>
        <span className="tray-actions"><button disabled={parlayTransferPending || teaserEligibleCount < 2} onClick={addEligibleToTeaser}>Build teaser</button>
        <button disabled={parlayTransferPending || tray.length < 2 || tray.length > 6} onClick={() => void addToParlay()}>{parlayTransferPending ? "Loading current odds…" : "Build parlay"}</button>
        <button className="primary-action" disabled={parlayTransferPending || !view?.activeSeason?.id || !!riskError} onClick={() => void quoteAll()}>Place bets</button></span>
        <p className="bet-slip-error" aria-live="polite">{riskError}</p></>}
    </section>
    <p><Link to={`/p/${slug}/overview`}>Pool home</Link></p></Layout>;
}
