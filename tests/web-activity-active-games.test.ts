import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadActivity } from "../src/contracts/http";
import { ActivityPageBody, MemberActivitySection } from "../src/web/pages/ActivityPage";

// Exercise the page's actual controls and render output with a small hook-state harness.
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  }
}));
vi.mock("react-router", () => ({ useParams: () => ({ slug: "pool" }), Link: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/web/components/Layout", () => ({ Layout: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/web/mobile-viewport", () => ({ useCompactWagerViewport: () => false }));

type Wager = ReadActivity["activity"]["wagers"][number];
const week = "2026-09-01T04:00:00.000Z";
const leg = (eventId: string, eventStartsAt = "2026-09-06T19:00:00.000Z", grade?: string): NonNullable<Wager["legs"]>[number] => ({
  eventId, eventStartsAt, grade, league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-09-01T00:00:00.000Z",
  policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", market: "spread", selection: "away", originalOdds: -110,
  awayTeam: eventId, homeTeam: "Home"
});
const wager = (wagerId: string, overrides: Partial<Wager> = {}): Wager => ({
  wagerId, seasonId: "s", memberId: "member", memberDisplayName: "Member", weekStart: week, type: "straight", status: "open",
  confirmedAt: "2026-09-01T00:00:00.000Z", performanceMicros: "0", legs: [leg(wagerId)], ...overrides
});
const mixed = wager("mixed", { type: "parlay", hiddenLegCount: 1, legs: [leg("Live"), leg("Future", "2026-09-07T20:00:00.000Z"), leg("Graded", undefined, "win")] });
const fixtures = [mixed,
  wager("settled", { status: "won", performanceMicros: "500000000", legs: [leg("Settled", undefined, "win")] }),
  wager("future", { memberId: "future-owner", memberDisplayName: "Future owner", legs: [leg("FutureOnly", "2026-09-07T20:00:00.000Z")] }),
  wager("hidden", { memberId: "hidden-owner", memberDisplayName: "Hidden owner", legs: undefined, hiddenLegCount: 2 }),
  wager("old-week", { weekStart: "2026-08-25T04:00:00.000Z", legs: [leg("OldWeek")] })
];

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function renderPage() { hooks.cursor = 0; return ActivityPageBody({ slug: "pool" }); }
function toggle(page: ReactNode, checked: boolean) {
  const control = elements(page).find((element) => element.type === "input" && element.props.type === "checkbox");
  expect(control, "Active games only checkbox").toBeDefined();
  control!.props.onChange({ target: { checked } });
  return renderPage();
}
function members(page: ReactNode) {
  return elements(page).filter((element) => element.type === MemberActivitySection).map((element) => element.props.member);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-06T20:00:00.000Z"));
  hooks.values = [{ commandVersion: "1", activity: { orders: [], wagers: fixtures } }];
});
afterEach(() => vi.restoreAllMocks());

describe("Activity active games toggle", () => {
  it("defaults off, retains full matching tickets and weekly P&L, and restores all bets when disabled", () => {
    const initial = renderPage();
    expect(elements(initial).find((element) => element.type === "input")?.props.checked).toBe(false);
    expect(members(initial)).toHaveLength(3);
    const active = toggle(initial, true);
    expect(members(active)).toEqual([expect.objectContaining({ memberId: "member", performanceMicros: "500000000", wagers: [mixed] })]);
    const html = renderToStaticMarkup(active);
    expect(html).toContain("Active games only");
    expect(html).toContain("Live");
    expect(html).toContain("Future");
    expect(html).toContain("Graded");
    expect(html).toContain("1 other selection hidden until game time.");
    expect(html).not.toContain("FutureOnly");
    expect(html).not.toContain("OldWeek");
    expect(members(toggle(active, false))).toEqual(members(initial));
  });

  it("shows +0.00 shares when a member's weekly wins and losses cancel out", () => {
    hooks.values[0] = { commandVersion: "1", activity: { orders: [], wagers: [mixed, fixtures[1], wager("loss", { status: "lost", performanceMicros: "-500000000", legs: [leg("Loss", undefined, "loss")] })] } };
    const initial = renderPage();
    expect(renderToStaticMarkup(initial)).toContain("Member<small>+0.00 shares</small>");
    expect(renderToStaticMarkup(toggle(initial, true))).toContain("Member<small>+0.00 shares</small>");
  });

  it("keeps week selection and the toggle available when no games match", () => {
    hooks.values[0] = { commandVersion: "1", activity: { orders: [], wagers: [fixtures[2]] } };
    const active = toggle(renderPage(), true);
    expect(members(active)).toEqual([]);
    expect(renderToStaticMarkup(active)).toContain("There are no bets right now");
    expect(elements(active).some((element) => element.type === "select")).toBe(true);
    expect(members(toggle(active, false))).toHaveLength(1);
  });

  it("applies the filter within the selected week without removing week options", () => {
    const active = toggle(renderPage(), true);
    const select = elements(active).find((element) => element.type === "select")!;
    expect(elements(select).filter((element) => element.type === "option")).toHaveLength(2);
    select.props.onChange({ target: { value: "2026-08-25T04:00:00.000Z" } });
    expect(members(renderPage())[0].wagers.map((row: Wager) => row.wagerId)).toEqual(["old-week"]);
  });

  it("uses the exact empty message even when there are no bets at all", () => {
    hooks.values[0] = { commandVersion: "1", activity: { orders: [], wagers: [] } };
    const page = renderPage();
    expect(renderToStaticMarkup(page)).toContain("There are no bets right now");
    expect(renderToStaticMarkup(toggle(page, true))).toContain("There are no bets right now");
  });
});
