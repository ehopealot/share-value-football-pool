import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/ActivityPage.tsx"), "utf8");

describe("Activity page", () => {
  it("offers a week selector and renders a compact wager table beneath every member ribbon", () => {
    expect(source).toContain('<label>Week <select');
    expect(source).toContain('].sort().reverse();');
    expect(source).toContain('weeks.includes(selectedWeek) ? selectedWeek : weeks[0]');
    expect(source).toContain('className="activity-member-ribbon"');
    expect(source).toContain('className="activity-table"');
    expect(source).toContain('<th>Start</th><th>Wager</th><th>Staked</th><th>P&amp;L</th>');
    expect(source).not.toContain('<th>Member</th>');
    expect(source).toContain('members.map((member) => <MemberActivitySection');
    expect(source).toContain('<span className="activity-staked">{stake.amount}{stake.odds && <> <small className="activity-staked-odds">{stake.odds}</small></>}</span>');
    expect(source).toContain('displayWagerStartTimes(wager)');
    expect(source).toContain('weekNumberLabel(start)');
    expect(source).not.toContain('Week of {weekLabel(start)}');
  });

  it("colors each selected leg from its own grade and preserves hidden tickets", () => {
    expect(source).toContain('formatActivityLeg');
    expect(source).toContain('const gradeClass = leg.grade === "loss" ? "activity-leg-loss" : leg.grade === "win" ? "activity-leg-win" : "activity-leg-neutral";');
    expect(source).toContain('className={gradeClass}');
    expect(source).toContain('<strong key={index}>{segment.text}</strong>');
    expect(source).not.toContain('activitySelectedOutcomeClass(wager)');
    expect(source).not.toContain('activityLegTimingClass(leg)');
    expect(source).toContain('Selection hidden until the game starts.');
  });

  it("colors wager P&L by result while leaving the weekly zero summary blank", () => {
    expect(source).toContain('activityWagerPerformanceClass');
    expect(source).toContain('<td className={activityWagerPerformanceClass(wager)}>{formatActivityWagerPerformance(wager)}</td>');
    expect(source).toContain('const performance = formatActivityPerformance(member.performanceMicros);');
    expect(source).toContain('{member.memberDisplayName}{performance && <small>{performance}</small>}');
  });
});
