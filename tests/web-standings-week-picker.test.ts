import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReadStandings } from "../src/contracts/http";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultStandingsSort, StandingsTable, standingsForWeek, standingsSortForView } from "../src/web/pages/StandingsPage";

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

  it("renders only Rank, Member, SVG, and Risked in a selected week", () => {
    const row = standing({ lockedMicros: "2000000", totalMicros: "12000000", notionalValueMicros: "13000000", gainMicros: "3000000", riskedMicros: "8000000" });
    const html = renderToStaticMarkup(createElement(StandingsTable, { standings: [row], weekly: true }));
    const header = html.match(/<thead><tr>(.*?)<\/tr><\/thead>/)?.[1] ?? "";
    for (const label of ["Rank", "Member", "SVG", "Risked"]) expect(header).toContain(`>${label}<`);
    expect(header.match(/<th/g)).toHaveLength(4);
    expect(header).not.toMatch(/>(Locked|Total|Notional value)</);
    expect(html).toContain('class="standings-table standings-weekly-table"');
    expect(html.match(/<td/g)).toHaveLength(3);
    expect(html).toContain(">3.00<");
    expect(html).toContain(">8.00<");
    expect(html).not.toContain(">2.00<");
    expect(html).not.toContain(">12.00<");
    expect(html).not.toContain(">13.00<");
  });

  it("keeps every holding column in All weeks", () => {
    const html = renderToStaticMarkup(createElement(StandingsTable, { standings: [standing({ lockedMicros: "2000000", totalMicros: "12000000", notionalValueMicros: "13000000" })] }));
    const header = html.match(/<thead><tr>(.*?)<\/tr><\/thead>/)?.[1] ?? "";
    for (const label of ["Rank", "Member", "Locked", "Total", "Notional value", "SVG", "Risked"]) expect(header).toContain(`>${label}<`);
    expect(header.match(/<th/g)).toHaveLength(7);
    expect(html).toContain('class="standings-table"');
    expect(html).not.toContain("standings-weekly-table");
    expect(html.match(/<td/g)).toHaveLength(6);
    expect(html).toContain(">2.00<");
    expect(html).toContain(">12.00<");
    expect(html).toContain(">13.00<");
  });

  it.each([["-1000000", "activity-leg-loss"], ["1000000", "activity-leg-win"], ["0", "activity-leg-push"]])("colors SVG %s in all-weeks and weekly views", (gainMicros, className) => {
    const rows = [standing({ gainMicros })];
    const weeks = [{ ...weeklyChanges[0]!, members: [{ userId: "member", gainMicros, riskedMicros: "4" }] }];
    for (const weekly of [false, true]) {
      const displayed = weekly ? standingsForWeek(rows, weeks, weeks[0]!.weekStart) : rows;
      const html = renderToStaticMarkup(createElement(StandingsTable, { standings: displayed, weekly }));
      expect(html).toContain(`<td class="${className}">`);
    }
  });

  it("falls back to rank only while a hidden holding column is selected", () => {
    const hiddenSort = { key: "lockedMicros" as const, ascending: false };
    expect(standingsSortForView(hiddenSort, true)).toBe(defaultStandingsSort);
    expect(standingsSortForView(hiddenSort, false)).toBe(hiddenSort);
  });

  it("uses the targeted mobile weekly-table layout", () => {
    const styles = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");
    expect(styles).toContain(".standings-weekly-table { width: 100%; table-layout: fixed; }");
    expect(styles).toContain(".standings-weekly-table th:nth-child(2), .standings-weekly-table td:nth-child(2) { overflow-wrap: anywhere; }");
    expect(styles).toContain(".standings-weekly-table td:nth-child(3), .standings-weekly-table td:nth-child(4) { white-space: normal; overflow-wrap: anywhere;");
    expect(styles).toContain(".standings-weekly-table th:nth-child(3), .standings-weekly-table th:nth-child(4) { text-align: right; }");
  });

  it("renders All weeks first and initializes the picker to it", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/StandingsPage.tsx"), "utf8");
    expect(source).toContain("useState(ALL_WEEKS_VALUE)");
    expect(source.indexOf(">All weeks</option>")).toBeLessThan(source.indexOf("weeklyChanges.map"));
  });
});
