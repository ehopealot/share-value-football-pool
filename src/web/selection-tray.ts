import { outcomeForSelection, type CanonicalSelection } from "./selection-matcher";
import type { MarketName } from "../odds/types";
import { MICROS_PER_UNIT, parseIntegerText } from "../domain/fixed-point";

/** Tray items hold identity only; lines and prices always resolve from the current board. */
export type TrayItem = { eventId: string; market: MarketName; selection: CanonicalSelection; wagerId: string; risk: string };
type BoardOffer = { eventId: string; market: MarketName; homeTeam?: string; awayTeam?: string; outcomes?: Array<{ name?: string }> };

const key = (slug: string) => `share-pool:tray:${slug}`;
const identity = (item: Pick<TrayItem, "eventId" | "market" | "selection">) => `${item.eventId}:${item.market}:${item.selection}`;

/** Checking adds by identity; unchecking removes regardless of risk or wager state. */
export function toggleTrayItem(items: TrayItem[], item: TrayItem): TrayItem[] {
  const id = identity(item);
  return items.some((candidate) => identity(candidate) === id) ? items.filter((candidate) => identity(candidate) !== id) : [...items, item];
}

/** Selections are exclusive per game and market column: checking one side replaces its sibling. */
export function toggleMarketExclusive(items: TrayItem[], item: TrayItem): TrayItem[] {
  const id = identity(item);
  if (items.some((candidate) => identity(candidate) === id)) return items.filter((candidate) => identity(candidate) !== id);
  return [...items.filter((candidate) => !(candidate.eventId === item.eventId && candidate.market === item.market)), item];
}

export function readSelectionTray(slug: string): TrayItem[] {
  try { return (JSON.parse(sessionStorage.getItem(key(slug)) ?? "[]") as unknown[]).filter(isTrayItem); }
  catch { return []; }
}
export function writeSelectionTray(slug: string, items: TrayItem[]): void { sessionStorage.setItem(key(slug), JSON.stringify(items)); }

const isTrayItem = (value: unknown): value is TrayItem => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.eventId === "string" && typeof candidate.wagerId === "string" && typeof candidate.risk === "string"
    && (candidate.market === "spread" || candidate.market === "total" || candidate.market === "moneyline")
    && (candidate.selection === "home" || candidate.selection === "away" || candidate.selection === "over" || candidate.selection === "under");
};

/** Resolves a tray identity to its current offer and outcome, or nothing when the board no longer carries it. */
export function resolveTrayItem(board: { offers?: BoardOffer[] }, item: { eventId: string; market: MarketName; selection: CanonicalSelection }): { offer: any; outcome: any } | undefined {
  const offer = board.offers?.find((candidate) => candidate.eventId === item.eventId && candidate.market === item.market);
  const outcome = offer && outcomeForSelection(offer, item.selection);
  return offer && outcome ? { offer, outcome } : undefined;
}

/** Teaser legs require a point-bearing spread or total. */
export function teaserEligible(item: Pick<TrayItem, "market">): boolean { return item.market === "spread" || item.market === "total"; }

/** Advisory slip checks mirror fixed limits before the authoritative quote/placement boundary. */
export function straightBatchRiskError(items: TrayItem[], limits: { maxSideBetMicros?: string; availableMicros?: string } = {}): string {
  if (items.some((item) => !/^\d+$/.test(item.risk) || BigInt(item.risk) <= 0n)) return "Whole shares required.";
  const risks = items.map((item) => BigInt(item.risk) * MICROS_PER_UNIT);
  if (limits.maxSideBetMicros !== undefined) {
    const max = parseIntegerText(limits.maxSideBetMicros);
    if (risks.some((risk) => risk > max)) return `Max bet per side: ${(max / MICROS_PER_UNIT).toString()} shares.`;
  }
  if (limits.availableMicros !== undefined) {
    const available = parseIntegerText(limits.availableMicros);
    const total = risks.reduce((sum, risk) => sum + risk, 0n);
    if (total > available) return `Selected bets total ${(total / MICROS_PER_UNIT).toString()} shares; only ${(available / MICROS_PER_UNIT).toString()} shares are available.`;
  }
  return "";
}

/** A teaser has one total-risk cap; the server separately enforces shared per-side exposure. */
export function teaserRiskError(risk: string, limits: { maxSideBetMicros?: string; availableMicros?: string } = {}): string {
  if (!/^\d+$/.test(risk) || BigInt(risk) <= 0n) return "Whole shares required.";
  const riskMicros = BigInt(risk) * MICROS_PER_UNIT;
  if (limits.maxSideBetMicros !== undefined) {
    const max = parseIntegerText(limits.maxSideBetMicros);
    if (riskMicros > max) return `Max bet per side: ${(max / MICROS_PER_UNIT).toString()} shares.`;
  }
  if (limits.availableMicros !== undefined) {
    const available = parseIntegerText(limits.availableMicros);
    if (riskMicros > available) return `Teaser risk ${risk} shares; only ${(available / MICROS_PER_UNIT).toString()} shares are available.`;
  }
  return "";
}
