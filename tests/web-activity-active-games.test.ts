import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadActivity } from "../src/contracts/http";
import { ActivityPageBody, MemberActivitySection } from "../src/web/pages/ActivityPage";

// Exercise the page's permanently selected view mode with a small hook-state harness.
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
const week = "2026-09-01T07:00:00.000Z";
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
  wager("old-week", { weekStart: "2026-08-25T07:00:00.000Z", legs: [leg("OldWeek")] })
];

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function renderActivityPage() { hooks.cursor = 0; return ActivityPageBody({ slug: "pool" }); }
function renderLiveGamesPage() { hooks.cursor = 0; return ActivityPageBody({ slug: "pool", mode: "live" }); }
function members(page: ReactNode) {
  return elements(page).filter((element) => element.type === MemberActivitySection).map((element) => element.props.member);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T20:00:00.000Z"));
  hooks.values = [{ commandVersion: "1", activity: { orders: [], wagers: fixtures } }];
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Activity and Live games views", () => {
  it("keeps Activity unfiltered and exposes only the Group by day checkbox", () => {
    const page = renderActivityPage();
    const html = renderToStaticMarkup(page);

    expect(members(page)).toHaveLength(3);
    expect(html).toContain('<h1 class="visually-hidden">Activity</h1>');
    expect(html).toContain("<h2>All bets</h2>");
    expect(html).toContain("Group by day");
    expect(html).not.toContain("Active games only");
    expect(elements(page).filter((element) => element.type === "input" && element.props.type === "checkbox")).toEqual([expect.objectContaining({ props: expect.objectContaining({ checked: false }) })]);
  });

  it("permanently filters Live games while retaining full-week member P&L", () => {
    const page = renderLiveGamesPage();
    const html = renderToStaticMarkup(page);

    expect(members(page)).toEqual([expect.objectContaining({ memberId: "member", performanceMicros: "500000000", wagers: [mixed] })]);
    expect(html).toContain('<h1 class="visually-hidden">Live games</h1>');
    expect(html).toContain("<h2>Live games</h2>");
    expect(html).toContain("Live");
    expect(html).toContain("Future");
    expect(html).toContain("Graded");
    expect(html).toContain("1 other selection hidden until game time.");
    expect(html).not.toContain("FutureOnly");
    expect(html).not.toContain("OldWeek");
    expect(html).not.toContain("Active games only");
  });

  it("shows +0.00 shares in Live games when a member's weekly wins and losses cancel out", () => {
    hooks.values[0] = { commandVersion: "1", activity: { orders: [], wagers: [mixed, fixtures[1], wager("loss", { status: "lost", performanceMicros: "-500000000", legs: [leg("Loss", undefined, "loss")] })] } };
    expect(renderToStaticMarkup(renderLiveGamesPage())).toContain("Member<small>+0.00 shares</small>");
  });

  it("omits week selection and Group by day when no Live games match", () => {
    hooks.values[0] = { commandVersion: "1", activity: { orders: [], wagers: [fixtures[2]] } };
    const page = renderLiveGamesPage();
    expect(members(page)).toEqual([]);
    expect(renderToStaticMarkup(page)).toContain("There are no bets right now");
    expect(elements(page).some((element) => element.type === "select")).toBe(false);
    expect(elements(page).filter((element) => element.type === "input" && element.props.type === "checkbox")).toHaveLength(0);
  });

  it("keeps Live on the current week and grouped by member regardless of Activity filters", () => {
    hooks.values[1] = "2026-08-25T07:00:00.000Z";
    hooks.values[2] = true;
    const page = renderLiveGamesPage();
    expect(members(page)[0].wagers.map((row: Wager) => row.wagerId)).toEqual(["mixed"]);
    expect(elements(page).some((element) => element.type === "select")).toBe(false);
    expect(renderToStaticMarkup(page)).not.toContain("Group by day");
  });

  it("uses the exact empty message in both views when there are no bets", () => {
    hooks.values[0] = { commandVersion: "1", activity: { orders: [], wagers: [] } };
    expect(renderToStaticMarkup(renderActivityPage())).toContain("There are no bets right now");
    expect(renderToStaticMarkup(renderLiveGamesPage())).toContain("There are no bets right now");
  });
});
