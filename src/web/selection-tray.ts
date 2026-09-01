import { outcomeForSelection, type CanonicalSelection } from "./selection-matcher";
import type { MarketName } from "../odds/types";

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

/** Whole positive share risks are required for every item before the batch can be quoted. */
export function straightBatchRiskError(items: TrayItem[]): string {
  return items.some((item) => !/^\d+$/.test(item.risk) || BigInt(item.risk) <= 0n) ? "Whole shares required." : "";
}
