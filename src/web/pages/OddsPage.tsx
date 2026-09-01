import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, buildStraightPlacement, commandOutcome, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { selectableOutcomes, selectionForOutcome } from "../selection-matcher";
import { addTeaserLeg, teaserLegForOutcome, writeTeaserSlip } from "../teaser-slip";
import { resolveTrayItem, straightBatchRiskError, teaserEligible, toggleMarketExclusive, type TrayItem } from "../selection-tray";
import { formatMicros, parseIntegerText } from "../../domain/fixed-point";
import { formatAmericanOdds, formatSignedLine } from "../odds-format";
import { ticketReturns } from "../wager-presentation";
export type BoardPick = { offer: any; outcome: any };
/** Review controls follow the parsed fail-closed board state, never retained editor data. */
export const boardEnablesWagerReview = (board: { offers?: unknown[]; feed?: { status?: string } } | undefined): boolean => board?.feed?.status === "current" && !!board.offers?.length;

export type MarketCell = { offer: any; outcome: any; label: string; selection: string; name: string; odds: string };
export type GameMarkets = { spread: { away?: MarketCell; home?: MarketCell }; total: { over?: MarketCell; under?: MarketCell }; moneyline: { away?: MarketCell; home?: MarketCell } };
export type GameRow = { eventId: string; startsAt: string; awayTeam: string; homeTeam: string; markets: GameMarkets };
/** Weeks run Tuesday–Monday inclusive on Eastern Time; season Week 1 starts Tuesday 2026-08-25 at 00:00 ET. */
const ET_TIME_ZONE = "America/New_York";
const etOffsetMs = (instant: Date): number => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET_TIME_ZONE, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) - instant.getTime();
};
const etMidnightUtc = (etDate: string): number => { const wallClock = Date.parse(`${etDate}T00:00:00Z`); return wallClock - etOffsetMs(new Date(wallClock)); };
export const SEASON_WEEK1_ANCHOR = etMidnightUtc("2026-08-25");
export function weekStartOf(date: Date): Date {
  const shifted = new Date(date.getTime() + etOffsetMs(date));
  const daysSinceTuesday = (shifted.getUTCDay() + 5) % 7;
  return new Date(etMidnightUtc(shifted.toISOString().slice(0, 10)) - daysSinceTuesday * 86_400_000);
}
export const inWeek = (startsAt: string, weekStart: string): boolean => { const time = new Date(startsAt).getTime(); const start = new Date(weekStart).getTime(); return time >= start && time < start + 7 * 24 * 60 * 60 * 1000; };
export const weekNumberLabel = (weekStart: string): string => { const number = Math.floor((new Date(weekStart).getTime() - SEASON_WEEK1_ANCHOR) / (7 * 24 * 60 * 60 * 1000)) + 1; return number >= 1 ? `Week ${number}` : "Preseason"; };
const americanToProbability = (price: number): number | undefined => price > 0 ? 100 / (price + 100) : price < 0 ? (-price) / (-price + 100) : undefined;
const probabilityToAmerican = (probability: number): number => { const decimal = 1 / probability; return decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1)); };
/** Removes the bookmaker's vig from a two-way moneyline: fair price = implied probability normalized by the overround. */
export function noVigAmerican(priceA: number, priceB: number): { a: number; b: number } | undefined {
  const impliedA = americanToProbability(priceA); const impliedB = americanToProbability(priceB);
  if (!impliedA || !impliedB) return undefined;
  const total = impliedA + impliedB;
  return { a: probabilityToAmerican(impliedA / total), b: probabilityToAmerican(impliedB / total) };
}
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
    // The moneyline column displays vig-free fair prices; tickets still settle on canonical book prices.
    const away = game.markets.moneyline.away; const home = game.markets.moneyline.home;
    const fair = away && home ? noVigAmerican(away.outcome.price, home.outcome.price) : undefined;
    if (away && fair) game.markets.moneyline.away = { ...away, odds: formatAmericanOdds(fair.a), label: `${away.outcome.name} ${formatAmericanOdds(fair.a)}` };
    if (home && fair) game.markets.moneyline.home = { ...home, odds: formatAmericanOdds(fair.b), label: `${home.outcome.name} ${formatAmericanOdds(fair.b)}` };
  }
  return [...rows.values()];
}

/** Builds the single-leg straight quote request for one tray item against its resolved pick. */
export function straightQuoteRequest(semantic: { pick: BoardPick; risk: string; wagerId: string; quoteKey: string }, seasonId: string) {
  const { offer } = semantic.pick; const selection = selectionForOutcome(offer, semantic.pick.outcome);
  if (!selection) throw new Error("CURRENT_OFFER_UNAVAILABLE");
  return { wagerId: semantic.wagerId, seasonId, riskMicros: (BigInt(semantic.risk) * 1000000n).toString(), rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: offer.eventId, canonicalBook: offer.canonicalBook, market: offer.market, selection, offerId: `${offer.eventId}:${offer.market}:${selection}`, offerVersion: offer.offerVersion }, quoteKey: semantic.quoteKey, commandId: semantic.quoteKey };
}

/** Batch item failures name the reason and keep the item retryable; unknown outcomes never auto-resubmit. */
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
type Batch = { tag: "quoting" } | { tag: "reviewing"; entries: ReviewEntry[]; quoteFailures: FailedEntry[] } | { tag: "placing"; entries: ReviewEntry[]; quoteFailures: FailedEntry[] } | { tag: "results"; placed: string[]; failed: FailedEntry[]; retryPlacements: ReviewEntry[] };
const placeEntries = async (slug: string, entries: ReviewEntry[], maxSideBetMicros?: string): Promise<{ placed: ReviewEntry[]; failed: Array<FailedEntry & { entry: ReviewEntry }>; retry: ReviewEntry[] }> => {
  const placed: ReviewEntry[] = []; const failed: Array<FailedEntry & { entry: ReviewEntry }> = []; const retry: ReviewEntry[] = [];
  for (const entry of entries) {
    try { await api.placeCommand(slug, "/wagers/straight/place", buildStraightPlacement(entry.quote, entry.item.wagerId, entry.mutationKey)); placed.push(entry); }
    catch (e) {
      const outcome = commandOutcome(e);
      // An unknown outcome must only ever resend the exact frozen placement; the server replays it idempotently.
      if (outcome === "retryable") retry.push(entry);
      failed.push({ label: entry.label, reason: failureReason(e, "place", maxSideBetMicros), entry });
    }
  }
  return { placed, failed, retry };
};
const displayedBoardValue = (offer: any, outcome: any) => offer.market === "total" ? `${outcome.point}` : offer.market === "moneyline" ? formatAmericanOdds(outcome.price) : formatSignedLine(outcome.point ?? outcome.price);
const trayLabel = (board: any, item: TrayItem, resolved: { offer: any; outcome: any } | undefined): string => resolved ? `${resolved.offer.awayTeam} at ${resolved.offer.homeTeam}: ${item.market} — ${resolved.outcome.name} ${displayedBoardValue(resolved.offer, resolved.outcome)}` : `${item.market} ${item.selection} (no longer available)`;

export function OddsPage() {
  const { slug = "" } = useParams(); const nav = useNavigate(); const [board, setBoard] = useState<any>(); const [view, setView] = useState<any>();
  const [league, setLeague] = useState(""); const [selectedWeek, setSelectedWeek] = useState("");
  const [tray, setTray] = useState<TrayItem[]>([]); const [batch, setBatch] = useState<Batch>(); const [notice, setNotice] = useState("");
  const [error, setError] = useState(""); const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const query = `?${new URLSearchParams(Object.fromEntries([["league", league]].filter(([, value]) => value)))}`;
  useEffect(() => { let active = true; void api.odds(slug, query).then((fresh) => { if (active) setBoard(fresh); }).catch(e => { if (active) setError(errorMessage(e)); }); return () => { active = false; }; }, [slug, query]);
  useEffect(() => { void api.poolView(slug).then(setView).catch(e => setError(errorMessage(e))); }, [slug]);
  useEffect(() => { setTray([]); }, [slug]);
  const persist = (next: TrayItem[]) => setTray(next);
  useEffect(() => { const backToBoard = () => setBatch((current) => current?.tag === "reviewing" ? undefined : current); window.addEventListener("popstate", backToBoard); return () => window.removeEventListener("popstate", backToBoard); }, []);
  const removeItem = (items: TrayItem[], item: TrayItem) => items.filter((candidate) => !(candidate.eventId === item.eventId && candidate.market === item.market && candidate.selection === item.selection));
  const pending = batch?.tag === "quoting" || batch?.tag === "placing";

  const quoteAll = async () => {
    const riskError = straightBatchRiskError(tray); if (riskError) return setError(riskError);
    if (!view?.activeSeason?.id) return setError("Open an active season before reviewing wagers.");
    setNotice(""); setError("");
    setBatch({ tag: "quoting" });
    // Always quote against a freshly fetched board so a retry after a line change cannot reuse stale authority.
    const fresh = await api.odds(slug, query).catch(() => undefined);
    if (fresh) setBoard(fresh);
    const current = fresh ?? board;
    const entries: ReviewEntry[] = []; const failures: FailedEntry[] = []; let nextTray = [...tray];
    for (const item of tray) {
      const resolved = resolveTrayItem(current, item);
      const label = trayLabel(current, item, resolved);
      if (!resolved) { failures.push({ label, reason: "This selection is no longer available on the board." }); nextTray = removeItem(nextTray, item); continue; }
      try {
        const quote = await api.quoteStraight(slug, straightQuoteRequest({ pick: resolved, risk: item.risk, wagerId: item.wagerId, quoteKey: crypto.randomUUID() }, view.activeSeason.id));
        entries.push({ item, pick: resolved, quote, mutationKey: crypto.randomUUID(), label });
      } catch (e) { failures.push({ label, reason: failureReason(e, "quote", view.pool.maxSideBetMicros) }); }
    }
    persist(nextTray);
    if (entries.length) window.history.pushState({ ...(window.history.state ?? {}), sharePoolBetReview: true }, "", window.location.href);
    setBatch(entries.length ? { tag: "reviewing", entries, quoteFailures: failures } : { tag: "results", placed: [], failed: failures, retryPlacements: [] });
  };

  const placeAll = async (reviewing: { entries: ReviewEntry[]; quoteFailures: FailedEntry[] }) => {
    setBatch({ ...reviewing, tag: "placing" });
    const result = await placeEntries(slug, reviewing.entries, view?.pool.maxSideBetMicros);
    const placedLabels = result.placed.map((entry) => entry.label);
    persist(tray.filter((item) => !result.placed.some((entry) => entry.item.eventId === item.eventId && entry.item.market === item.market && entry.item.selection === item.selection)));
    if (result.retry.length > 0) {
      // Unknown outcomes keep their frozen placement on screen; resending the exact same wager cannot double-place.
      setBatch({ tag: "reviewing", entries: result.retry, quoteFailures: [] });
      setError("Placement result unknown.");
      return;
    }
    setBatch({ tag: "results", placed: placedLabels, failed: result.failed.map(({ label, reason }) => ({ label, reason })), retryPlacements: [] });
    void api.odds(slug, query).then(setBoard).catch(() => undefined);
  };

  const addEligibleToTeaser = () => {
    // Build a fresh teaser from this slip; a prior draft must never affect these selections.
    let slip: ReturnType<typeof teaserLegForOutcome>[] = []; let added = 0; const errors: string[] = []; const addedItems: TrayItem[] = [];
    for (const item of tray) {
      if (!teaserEligible(item)) continue;
      const resolved = resolveTrayItem(board, item);
      if (!resolved || typeof resolved.outcome.point !== "number") continue;
      const merged = addTeaserLeg(slip, teaserLegForOutcome(resolved.offer, resolved.outcome, item.selection));
      if (merged.error) { if (!errors.includes(merged.error)) errors.push(merged.error); continue; }
      slip = merged.legs; added++; addedItems.push(item);
    }
    writeTeaserSlip(slug, slip);
    persist(tray.filter((item) => !addedItems.some((added) => added.eventId === item.eventId && added.market === item.market && added.selection === item.selection)));
    setError(errors[0] ?? "");
    if (added > 0) return nav(`/p/${slug}/teaser`);
    setNotice(added ? `${added} selection${added === 1 ? "" : "s"} added to the teaser slip.` : "");
  };

  const backToBoard = () => window.history.state?.sharePoolBetReview ? window.history.back() : setBatch(undefined);

  if (batch?.tag === "reviewing" || batch?.tag === "placing") {
    const entries = batch.entries;
    return <Layout signedIn><h1>Review straight wagers</h1><p role="status">{batch.tag === "placing" ? "Placing wagers…" : `${entries.length} straight wager${entries.length === 1 ? "" : "s"} ready to place.`}{batch.quoteFailures.length ? ` ${batch.quoteFailures.length} selection${batch.quoteFailures.length === 1 ? "" : "s"} could not be quoted and remain in your tray.` : ""}</p>
      <div className="table-scroll" tabIndex={0}><table><caption>Bet confirmation</caption><thead><tr><th>Matchup</th><th>Pick</th><th>Odds</th><th>Risk</th><th>To win</th></tr></thead><tbody>{entries.map((entry) => { const details = straightReviewDetails(entry); return <tr key={entry.item.wagerId}><td>{details.matchup}</td><td>{details.pick}</td><td>{details.odds}</td><td>{details.risk}</td><td>{details.toWin}</td></tr>; })}</tbody></table></div>
      <span className="tray-actions"><button className="primary-action" disabled={batch.tag === "placing"} onClick={() => void placeAll(batch)}>{batch.tag === "placing" ? "Placing…" : `Place ${entries.length} wager${entries.length === 1 ? "" : "s"}`}</button>
      <button disabled={batch.tag === "placing"} onClick={backToBoard}>Back to board</button></span>
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

  const currentWeek = weekStartOf(new Date()).toISOString();
  // Every season week from the anchor through today is selectable (history included), plus any week carrying live offers.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const elapsedWeeks = Math.max(0, Math.floor((weekStartOf(new Date()).getTime() - SEASON_WEEK1_ANCHOR) / WEEK_MS) + 1);
  const weekOptions: string[] = [...new Set<string>([...Array.from({ length: elapsedWeeks }, (_, index) => new Date(SEASON_WEEK1_ANCHOR + index * WEEK_MS).toISOString()), ...(board?.offers ?? []).map((offer: any) => weekStartOf(new Date(offer.startsAt)).toISOString())])].sort();
  // Default to the earliest week with games (future weeks count); the current week is the fallback.
  const week = selectedWeek || weekOptions.find((option) => (board?.offers ?? []).some((offer: any) => inWeek(offer.startsAt, option))) || currentWeek;
  const games = groupBoardByEvent((board?.offers ?? []).filter((offer: any) => !week || inWeek(offer.startsAt, week)));
  const identity = (item: Pick<TrayItem, "eventId" | "market" | "selection">) => `${item.eventId}:${item.market}:${item.selection}`;
  const inTray = (eventId: string, market: string, selection: string) => tray.some((item) => identity(item) === `${eventId}:${market}:${selection}`);
  const toggle = (cell: MarketCell) => persist(toggleMarketExclusive(tray, { eventId: cell.offer.eventId, market: cell.offer.market, selection: cell.selection, wagerId: crypto.randomUUID(), risk: "" } as TrayItem));
  // Teasers need at least two legs, so the builder stays disabled for single-game slips.
  const teaserEligibleCount = tray.filter((item) => teaserEligible(item) && resolveTrayItem(board ?? {}, item) && typeof resolveTrayItem(board ?? {}, item)!.outcome.point === "number").length;
  const riskError = straightBatchRiskError(tray);
  const balance = view?.activeSeason && view.currentMember.seasonBalances.find((item: any) => item.seasonId === view.activeSeason.id);
  const available = balance ? parseIntegerText(balance.availableMicros) : 0n;
  const total = balance ? available + parseIntegerText(balance.lockedMicros) : 0n;
  return <Layout signedIn><h1>Odds board</h1>{view && <p className="pool-context"><Link to={`/p/${slug}/overview`}>{view.pool.name}</Link>{view.activeSeason ? ` · ${view.activeSeason.label}` : ""}</p>}<p role="status">Feed status: {board?.feed.status ?? "loading"} — {board?.feed.message}</p>
    {error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <label>League <select value={league} onChange={e => setLeague(e.target.value)}><option value="">All football</option><option value="nfl">NFL</option><option value="ncaaf">NCAA football</option></select></label>
    <label>Week <select value={week} onChange={e => setSelectedWeek(e.target.value)}>{weekOptions.map((option) => <option key={option} value={option}>{weekNumberLabel(option)}{option === currentWeek ? " (current)" : ""}</option>)}</select></label>
    <div className="table-scroll" tabIndex={0}><table className="odds-board"><caption>Current odds</caption><thead><tr><th scope="col">Start</th><th scope="col">Matchup</th><th scope="col">Spread</th><th scope="col">Total</th><th scope="col">Moneyline</th></tr></thead><tbody>{games.flatMap((game) => {
      const top: Array<MarketCell | undefined> = [game.markets.spread.away, game.markets.total.over, game.markets.moneyline.away];
      const bottom: Array<MarketCell | undefined> = [game.markets.spread.home, game.markets.total.under, game.markets.moneyline.home];
      const cell = (option: MarketCell | undefined, index: number) => {
        // Only the current Tuesday–Monday week is bettable; future weeks are visible but locked.
        const locked = !inWeek(game.startsAt, currentWeek);
        const classes = ["odds-option", locked ? "locked" : "", option?.offer.market === "total" ? "odds-option-total" : ""].filter(Boolean).join(" ");
        return option ? <td className="odds-cell" key={`${game.eventId}-${index}-${option.selection}`}><label className={classes}><input type="checkbox" disabled={locked} checked={inTray(option.offer.eventId, option.offer.market, option.selection)} onChange={() => toggle(option)} /><span className="odds-option-name">{option.name}</span><strong>{option.odds}</strong></label></td> : <td className="odds-cell odds-empty" key={`${game.eventId}-${index}-empty`} />;
      };
      const kickoff = new Date(game.startsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      return [<tr key={`${game.eventId}-top`} className="odds-game-top"><td rowSpan={2} className="odds-start">{kickoff}</td><th scope="row" rowSpan={2} className="odds-matchup"><span>{game.awayTeam}</span><span>{game.homeTeam}</span><small className="odds-mobile-start">{kickoff}</small></th>{top.map(cell)}</tr>, <tr key={`${game.eventId}-bottom`} className="odds-game-bottom">{bottom.map(cell)}</tr>];
    })}</tbody></table></div>
    {board && games.length === 0 && <p>No games to show for this week.</p>}
    <section aria-label="Selection tray" className="selection-tray"><h2>Bet slip</h2>{view?.activeSeason && <p className="pool-balance">Your shares: Total <strong>{formatMicros(total, 2)}</strong> · Available to bet <strong>{formatMicros(available, 2)}</strong></p>}
      {tray.length === 0 ? <p>Check options on the board to build straight wagers or a teaser.</p> : <><ul className="selection-tray-list">{tray.map((item) => { const resolved = resolveTrayItem(board ?? {}, item); const label = trayLabel(board, item, resolved); return <li key={identity(item)}>{resolved ? <span className="tray-item-label">{label}</span> : <em className="tray-item-label">{label}</em>}<label> Risk <input type="number" min="1" step="1" value={item.risk} aria-label={`Risk in whole shares for ${label}`} onChange={e => persist(tray.map((candidate) => identity(candidate) === identity(item) ? { ...candidate, risk: e.target.value } : candidate))} /></label><button onClick={() => persist(removeItem(tray, item))}>Remove</button></li>; })}</ul>
        <span className="tray-actions"><button disabled={teaserEligibleCount < 2} onClick={addEligibleToTeaser}>Build teaser</button>
        <button className="primary-action" disabled={!view?.activeSeason?.id || !!riskError} onClick={() => void quoteAll()}>Place bets</button></span>
        <p className="bet-slip-error" aria-live="polite">{riskError}</p></>}
    </section>
    <p><Link to={`/p/${slug}/overview`}>Pool home</Link></p></Layout>;
}
