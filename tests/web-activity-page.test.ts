import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/ActivityPage.tsx"), "utf8");

describe("Activity page", () => {
  it("offers a week selector and renders one compact performance table", () => {
    expect(source).toContain('<label>Week <select');
    expect(source).toContain('].sort().reverse();');
    expect(source).toContain('weeks.includes(selectedWeek) ? selectedWeek : weeks[0]');
    expect(source).toContain('className="activity-table"');
    expect(source).toContain('<th>Member</th><th>Start</th><th>Wager</th><th>Staked</th><th>Result</th><th>P&amp;L</th>');
    expect(source).toContain('<td>{formatActivityStake(wager)}</td>');
    expect(source).toContain('displayWagerStartTime(wager)');
    expect(source).toContain('weekNumberLabel(start)');
    expect(source).not.toContain('Week of {weekLabel(start)}');
  });

  it("uses semantic selected-pick rendering and preserves hidden tickets", () => {
    expect(source).toContain('formatActivityLeg');
    expect(source).toContain('className={activitySelectedOutcomeClass(wager)}');
    expect(source).toContain('<strong key={index} className={activitySelectedOutcomeClass(wager)}>{segment.text}</strong>');
    expect(source).toContain('Selection hidden until the game starts.');
  });

  it("leaves zero Activity performance blank in both wager and weekly-summary cells", () => {
    expect(source).toContain('formatActivityWagerPerformance');
    expect(source).toContain('<td>{formatActivityWagerPerformance(wager)}</td>');
    expect(source).toContain('formatActivityPerformance(member.performanceMicros) && <small>{formatActivityPerformance(member.performanceMicros)}</small>');
  });
});
