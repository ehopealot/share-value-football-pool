import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadActivity } from "../src/contracts/http";
import { filterActivityDaysForActiveGames, groupActivityDaysForWeek } from "../src/web/activity-presentation";
import { ActivityPageBody } from "../src/web/pages/ActivityPage";

type Wager = ReadActivity["activity"]["wagers"][number];
const week = "2026-09-08T07:00:00.000Z";
const leg = (eventId: string, eventStartsAt: string, grade?: string): NonNullable<Wager["legs"]>[number] => ({
  eventId, eventStartsAt, grade, league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-09-01T00:00:00.000Z",
  policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", market: "spread", selection: "away", originalOdds: -110,
  awayTeam: eventId, homeTeam: "Home"
});
const wager = (wagerId: string, overrides: Partial<Wager> = {}): Wager => ({
  wagerId, seasonId: "s", memberId: "member", memberDisplayName: "Member", weekStart: week, type: "straight", status: "open",
  confirmedAt: "2026-09-01T00:00:00.000Z", performanceMicros: "0", legs: [leg(wagerId, "2026-09-13T18:00:00.000Z")], ...overrides
});
const now = Date.parse("2026-09-14T19:00:00.000Z");

const dailyFixtures = [
  wager("first-loss", { type: "parlay", status: "lost", performanceMicros: "-150000000", legs: [leg("loss-thu", "2026-09-10T18:00:00.000Z", "loss"), leg("loss-fri", "2026-09-11T18:00:00.000Z", "loss")] }),
  wager("live", { type: "parlay", legs: [leg("won-sat", "2026-09-12T18:00:00.000Z", "win"), leg("live-sun", "2026-09-13T18:00:00.000Z"), leg("future-mon", "2026-09-14T20:00:00.000Z")] }),
  wager("won-sun", { type: "teaser", status: "won", performanceMicros: "200000000", legs: [leg("win-sat", "2026-09-12T18:00:00.000Z", "win"), leg("win-sun", "2026-09-13T18:00:00.000Z", "win")] }),
  wager("future", { memberId: "future", memberDisplayName: "Future", legs: [leg("future-only", "2026-09-14T20:00:00.000Z")] }),
  wager("hidden", { memberId: "hidden", memberDisplayName: "Hidden", legs: undefined, hiddenLegCount: 2 })
];

describe("Activity day groups", () => {
  it("assigns each safe ticket once: first loss day, latest started day, or Upcoming", () => {
    const days = groupActivityDaysForWeek(dailyFixtures, week, now);

    expect(days.map((day) => day.label)).toEqual(["Thu", "Sun", "Upcoming"]);
    expect(days.map((day) => day.performanceMicros)).toEqual(["-150000000", "200000000", "0"]);
    expect(days[0]!.members).toEqual([expect.objectContaining({ memberId: "member", performanceMicros: "-150000000", wagers: [expect.objectContaining({ wagerId: "first-loss" })] })]);
    expect(days[1]!.members).toEqual([expect.objectContaining({ memberId: "member", performanceMicros: "200000000", wagers: [expect.objectContaining({ wagerId: "live" }), expect.objectContaining({ wagerId: "won-sun" })] })]);
    expect(days[2]!.members.map((member) => ({ id: member.memberId, wagers: member.wagers.map((row) => row.wagerId) }))).toEqual([{ id: "future", wagers: ["future"] }, { id: "hidden", wagers: ["hidden"] }]);
    expect(days.flatMap((day) => day.members.flatMap((member) => member.wagers)).map((row) => row.wagerId).sort()).toEqual(dailyFixtures.map((row) => row.wagerId).sort());
  });

  it("includes all weeks when no week is selected, without merging distinct calendar days", () => {
    const older = wager("older", { weekStart: "2026-09-01T07:00:00.000Z", performanceMicros: "1000000", legs: [leg("older-sun", "2026-09-06T18:00:00.000Z", "win")] });
    const days = groupActivityDaysForWeek([...dailyFixtures, older], undefined, now);
    expect(days.filter((day) => day.label === "Sun")).toHaveLength(2);
    expect(days.flatMap((day) => day.members.flatMap((member) => member.wagers))).toHaveLength(dailyFixtures.length + 1);
    expect(groupActivityDaysForWeek([...dailyFixtures, older], week, now).flatMap((day) => day.members.flatMap((member) => member.wagers))).toHaveLength(dailyFixtures.length);
  });

  it("retains unfiltered day P&L when Active games only removes settled tickets", () => {
    const days = groupActivityDaysForWeek(dailyFixtures, week, now);
    const active = filterActivityDaysForActiveGames(days, now);

    expect(active).toEqual([expect.objectContaining({ label: "Sun", performanceMicros: "200000000", members: [expect.objectContaining({ memberId: "member", performanceMicros: "200000000", wagers: [expect.objectContaining({ wagerId: "live" })] })] })]);
  });
});

// Exercise the actual page controls and grouped table markup in a compact hook-state harness.
const hooks = vi.hoisted(() => ({ compact: false, cursor: 0, values: [] as unknown[] }));
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
vi.mock("react-router", () => ({ useParams: () => ({ slug: "pool" }), Link: ({ children, to }: { children: ReactNode; to: string }) => createElement("a", { href: to }, children) }));
vi.mock("../src/web/components/Layout", () => ({ Layout: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/web/mobile-viewport", () => ({ useCompactWagerViewport: () => hooks.compact }));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function renderPage() { hooks.cursor = 0; return ActivityPageBody({ slug: "pool" }); }
function toggleCheckbox(page: ReactNode, index: number, checked: boolean) {
  const controls = elements(page).filter((element) => element.type === "input" && element.props.type === "checkbox");
  controls[index]!.props.onChange({ target: { checked } });
  return renderPage();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  hooks.compact = false;
  hooks.values = [{ commandVersion: "1", activity: { orders: [], wagers: dailyFixtures } }];
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Activity Group by day control and tables", () => {
  it("is an independent desktop checkbox and renders player-linked in-table daily ribbons", () => {
    const initial = renderPage();
    const controls = elements(initial).filter((element) => element.type === "input" && element.props.type === "checkbox");
    expect(controls).toHaveLength(2);
    expect(controls.map((control) => control.props.checked)).toEqual([false, false]);
    expect(renderToStaticMarkup(initial)).toContain("Group by day");
    expect(renderToStaticMarkup(initial)).not.toContain("<details");

    const grouped = toggleCheckbox(initial, 1, true);
    const html = renderToStaticMarkup(grouped);
    expect(html).toContain('<section class="activity-day-section">');
    expect(html).toContain('<h3 class="activity-day-ribbon">Thu<small>Pool net -150.00 shares</small></h3>');
    expect(html).toContain('<h3 class="activity-day-ribbon">Sun<small>Pool net +200.00 shares</small></h3>');
    expect(html).toContain('<h3 class="activity-day-ribbon">Upcoming<small>Pool net +0.00 shares</small></h3>');
    expect(html).toContain('class="activity-day-member-ribbon"');
    expect(html).toContain('<a href="/p/pool/member/member">Member</a>');
    expect(html).toContain('<small>+200.00 shares</small>');
    expect(html).toContain('<a href="/p/pool/member/future">Future</a>');
  });

  it("uses one accessible Options disclosure with both checkbox options on compact viewports", () => {
    hooks.compact = true;
    const page = renderPage();
    const html = renderToStaticMarkup(page);

    expect(html).toContain('<details class="activity-options">');
    expect(html).toContain("<summary>Options</summary>");
    expect(html).toContain("Active games only");
    expect(html).toContain("Group by day");
    expect(elements(page).filter((element) => element.type === "input" && element.props.type === "checkbox")).toHaveLength(2);
  });

  it("labels only dated Upcoming tickets and skips redundant Upcoming ribbons", () => {
    hooks.compact = true;
    const html = renderToStaticMarkup(toggleCheckbox(renderPage(), 1, true));
    const upcoming = html.split('<h3 class="activity-day-ribbon">Upcoming<small>Pool net +0.00 shares</small></h3>')[1]!;
    expect(upcoming).toContain('<tr class="wager-date-row"><th colSpan="4">Mon, Sep 14</th></tr>');
    expect(upcoming).not.toContain('<tr class="wager-date-row"><th colSpan="4">Upcoming</th></tr>');
  });

  it("keeps daily tables visible when the new All weeks option is selected", () => {
    const initial = renderPage();
    const select = elements(initial).find((element) => element.type === "select")!;
    const allWeeks = elements(select.props.children).find((element) => element.type === "option" && element.props.children === "All weeks")!;
    select.props.onChange({ target: { value: allWeeks.props.value } });
    const html = renderToStaticMarkup(toggleCheckbox(renderPage(), 1, true));
    expect(html).toContain('<h3 class="activity-day-ribbon">Thu<small>Pool net -150.00 shares</small></h3>');
    expect(html).toContain('<h3 class="activity-day-ribbon">Upcoming<small>Pool net +0.00 shares</small></h3>');
  });

  it("preserves a daily P&L ribbon after filtering to an active ticket", () => {
    const active = toggleCheckbox(renderPage(), 0, true);
    const grouped = toggleCheckbox(active, 1, true);
    const html = renderToStaticMarkup(grouped);

    expect(html).toContain("Sun");
    expect(html).toContain("Member");
    expect(html).toContain("+200.00 shares");
    expect(html).toContain("live-sun");
    expect(html).not.toContain("won-sun");
  });
});
