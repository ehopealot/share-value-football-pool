import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OddsPage } from "../src/web/pages/OddsPage";
import type { TrayItem } from "../src/web/selection-tray";

// Follow the page tests' lightweight hook harness to inspect real controls and handlers.
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], bettingOpen: true, navigate: vi.fn() }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: () => {},
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (calculate: () => unknown) => calculate(),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  }
}));
vi.mock("react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-router")>(),
  useParams: () => ({ slug: "pool" }),
  useNavigate: () => hooks.navigate
}));
vi.mock("../src/web/betting-window", () => ({ useBettingWindow: () => ({ open: hooks.bettingOpen, currentWeek: "2026-09-01T07:00:00.000Z" }) }));

const picks = (count: number): TrayItem[] => Array.from({ length: count }, (_, index) => ({ eventId: `e${index}`, wagerId: `w${index}`, market: "spread", selection: "home", risk: "" }));
const moneyline: TrayItem = { eventId: "ml", wagerId: "ml", market: "moneyline", selection: "home", risk: "" };
const offer = (item: TrayItem) => ({
  eventId: item.eventId, league: "nfl", market: item.market, homeTeam: "Home", awayTeam: "Away",
  startsAt: "2026-09-06T17:00:00.000Z", canonicalBook: "DraftKings", retrievedAt: "2026-09-01T10:00:00.000Z",
  policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: `v-${item.eventId}`,
  outcomes: item.market === "moneyline" ? [{ name: "Home", price: -110 }, { name: "Away", price: 110 }]
    : [{ name: item.market === "total" ? "Over" : "Home", price: -110, point: item.market === "total" ? 44.5 : -3.5 }]
});
const seed = (items: TrayItem[], offers = items.map(offer), pending = false) => {
  hooks.values = [{ offers, feed: { status: "current", message: "Current odds" } }, undefined, "", "", "", items, undefined, pending, ""];
};
type Props = { children?: ReactNode; disabled?: boolean; onClick?: () => void };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function renderPage() { hooks.cursor = 0; return OddsPage(); }
function button(label: string) {
  const control = elements(renderPage()).find((node) => node.type === "button" && node.props.children === label);
  expect(control, label).toBeDefined();
  return control!;
}
function removeLastSelection() {
  elements(renderPage()).filter((node) => node.type === "button" && node.props.children === "Remove").at(-1)!.props.onClick!();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-02T18:00:00.000Z"));
  vi.stubGlobal("sessionStorage", { setItem: vi.fn() });
  hooks.bettingOpen = true;
  hooks.navigate.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("bet slip builder eligibility", () => {
  it.each([1, 2, 6, 7])("enables both builders only for 2–6 selections (%i picks)", (count) => {
    seed(picks(count));
    const disabled = count < 2 || count > 6;
    expect(button("Build teaser").props.disabled).toBe(disabled);
    expect(button("Build parlay").props.disabled).toBe(disabled);
  });

  it("disables both builders for seven selections and re-enables them after removing the seventh", () => {
    seed(picks(7));
    expect(button("Build teaser").props.disabled).toBe(true);
    expect(button("Build parlay").props.disabled).toBe(true);
    removeLastSelection();
    expect(button("Build teaser").props.disabled).toBe(false);
    expect(button("Build parlay").props.disabled).toBe(false);
  });

  it("disables teasers, but not parlays, with a moneyline and recovers when it is removed", () => {
    seed([...picks(2), moneyline]);
    expect(button("Build teaser").props.disabled).toBe(true);
    expect(button("Build parlay").props.disabled).toBe(false);
    removeLastSelection();
    expect(button("Build teaser").props.disabled).toBe(false);
  });

  it("disables both builders when an over-limit slip also includes a moneyline", () => {
    seed([...picks(6), moneyline]);
    expect(button("Build teaser").props.disabled).toBe(true);
    expect(button("Build parlay").props.disabled).toBe(true);
  });

  it("accepts a mix of spread and total selections", () => {
    seed([...picks(1), { ...moneyline, market: "total", selection: "over" }]);
    expect(button("Build teaser").props.disabled).toBe(false);
    expect(button("Build parlay").props.disabled).toBe(false);
  });

  it("disables teasers if any selection cannot be resolved from the board", () => {
    seed(picks(3), picks(2).map(offer));
    expect(button("Build teaser").props.disabled).toBe(true);
  });

  it("disables teasers if any selection lacks a point-bearing line", () => {
    const offers = picks(3).map(offer);
    offers[2]!.outcomes = [{ name: "Home", price: -110 }];
    seed(picks(3), offers);
    expect(button("Build teaser").props.disabled).toBe(true);
  });

  it.each([
    { reason: "too many selections", items: picks(7) },
    { reason: "a moneyline", items: [...picks(2), moneyline] }
  ])("does not transfer a teaser with $reason even if its handler is invoked", ({ items }) => {
    seed(items);
    button("Build teaser").props.onClick!();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
    expect(hooks.navigate).not.toHaveBeenCalled();
  });

  it("keeps valid builders disabled while betting is closed or a transfer is pending", () => {
    seed(picks(2));
    hooks.bettingOpen = false;
    expect(button("Build teaser").props.disabled).toBe(true);
    expect(button("Build parlay").props.disabled).toBe(true);
    hooks.bettingOpen = true;
    seed(picks(2), undefined, true);
    expect(button("Build teaser").props.disabled).toBe(true);
    expect(button("Loading current odds…").props.disabled).toBe(true);
  });
});
