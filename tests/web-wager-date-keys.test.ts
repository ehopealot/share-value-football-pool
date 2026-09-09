import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadMyWagers } from "../src/contracts/http";
import { MemberActivitySection } from "../src/web/pages/ActivityPage";
import { MyWagersPage } from "../src/web/pages/MyWagersPage";
import { groupActivityMembersForWeek } from "../src/web/activity-presentation";

const state = vi.hoisted(() => ({ compact: false, wagers: [] as ReadMyWagers["wagers"] }));
vi.mock("../src/web/mobile-viewport", () => ({ useCompactWagerViewport: () => state.compact }));
vi.mock("react-router", async (importOriginal) => ({ ...await importOriginal<typeof import("react-router")>(), useParams: () => ({ slug: "pool" }) }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: () => {},
  useState: (initial: unknown) => [initial === undefined ? { wagers: state.wagers } : initial, vi.fn()]
}));

// Inspect the actual sibling keys React reconciles, without mounting nested wager cells.
function tableBodies(node: ReactNode): ReactElement<{ children: ReactElement[] }>[] {
  if (Array.isArray(node)) return node.flatMap(tableBodies);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  if (node.type === "tbody") return [node as ReactElement<{ children: ReactElement[] }>];
  return tableBodies(node.props.children);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T20:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

const weekStart = "2026-09-01T07:00:00.000Z";
const wager = (wagerId: string, legs: Array<{ eventStartsAt: string; grade: string | null }>) => ({
  wagerId, legs, weekStart, memberId: "member", memberDisplayName: "Member", type: "parlay", status: "open",
  confirmedAt: "2026-09-01T00:00:00.000Z", performanceMicros: "0"
}) as ReadMyWagers["wagers"][number];

const wagers = [
  wager("multi-day", [{ eventStartsAt: "2026-09-03T18:00:00.000Z", grade: "win" }, { eventStartsAt: "2026-09-04T18:00:00.000Z", grade: null }]),
  wager("thursday", [{ eventStartsAt: "2026-09-03T19:00:00.000Z", grade: null }]),
  wager("friday", [{ eventStartsAt: "2026-09-04T20:00:00.000Z", grade: null }])
];

const renderers = {
  Activity: () => MemberActivitySection({ member: groupActivityMembersForWeek(state.wagers, weekStart)[0]! }),
  "My Bets": () => MyWagersPage()
};

describe.each(Object.entries(renderers))("%s date ribbon reconciliation", (_name, render) => {
  it("keeps sibling keys unique when recurring anchor dates regroup for mobile", () => {
    state.wagers = wagers;
    state.compact = false;
    const desktopRows = tableBodies(render())[0]!.props.children;
    const desktopRibbons = desktopRows.filter((row) => row.type === "tr");
    // Earliest-kickoff order interleaves Friday, Thursday, Friday anchors.
    expect(desktopRibbons).toHaveLength(3);
    expect(new Set(desktopRows.map((row) => row.key)).size).toBe(desktopRows.length);

    state.compact = true;
    const mobileRows = tableBodies(render())[0]!.props.children;
    expect(mobileRows.filter((row) => row.type === "tr")).toHaveLength(2);
    expect(new Set(mobileRows.map((row) => row.key)).size).toBe(mobileRows.length);
    expect(mobileRows.filter((row) => row.type !== "tr").map((row) => row.key)).toEqual(["thursday", "multi-day", "friday"]);
    // Surviving ribbons retain their identity across the viewport update.
    for (const ribbon of mobileRows.filter((row) => row.type === "tr")) {
      expect(desktopRibbons.map((row) => row.key)).toContain(ribbon.key);
    }
  });
});
