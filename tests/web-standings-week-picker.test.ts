import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReadStandings } from "../src/contracts/http";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StandingsTable, standingsForWeek } from "../src/web/pages/StandingsPage";

const standing = (overrides: Partial<ReadStandings["standings"][number]> = {}): ReadStandings["standings"][number] => ({
  rank: 1, userId: "member", displayName: "Member", availableMicros: "10", lockedMicros: "2", totalMicros: "12",
  priceMicros: "1100000", notionalValueMicros: "13", gainMicros: "3", riskedMicros: "8", ...overrides
});
const weeklyChanges: ReadStandings["weeklyChanges"] = [{
  weekStart: "2026-09-01T07:00:00.000Z",
  members: [{ userId: "member", gainMicros: "-2", riskedMicros: "4" }]
}];

describe("Standings week picker", () => {
  it("keeps season-wide standings for All weeks", () => {
    const rows = [standing()];
    expect(standingsForWeek(rows, weeklyChanges, undefined)).toBe(rows);
  });

  it("changes only SVG and Risked for a selected week", () => {
    const season = standing();
    expect(standingsForWeek([season], weeklyChanges, weeklyChanges[0]!.weekStart)).toEqual([{
      ...season, gainMicros: "-2", riskedMicros: "4"
    }]);
  });

  it.each([["-1000000", "activity-leg-loss"], ["1000000", "activity-leg-win"], ["0", "activity-leg-push"]])("colors SVG %s in all-weeks and weekly views", (gainMicros, className) => {
    const rows = [standing({ gainMicros })];
    const weeks = [{ ...weeklyChanges[0]!, members: [{ userId: "member", gainMicros, riskedMicros: "4" }] }];
    for (const week of [undefined, weeks[0]!.weekStart]) {
      const html = renderToStaticMarkup(createElement(StandingsTable, { standings: standingsForWeek(rows, weeks, week) }));
      expect(html).toContain(`<td class="${className}">`);
    }
  });

  it("renders All weeks first and initializes the picker to it", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/StandingsPage.tsx"), "utf8");
    expect(source).toContain("useState(ALL_WEEKS_VALUE)");
    expect(source.indexOf(">All weeks</option>")).toBeLessThan(source.indexOf("weeklyChanges.map"));
  });
});
