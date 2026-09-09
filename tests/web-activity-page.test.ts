import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/ActivityPage.tsx"), "utf8");

describe("Activity page", () => {
  it("keeps an accessible Activity heading without displaying a duplicate page title", () => {
    expect(source).toContain('<h1 className="visually-hidden">Activity</h1>');
  });

  it("offers a week selector and renders a compact wager table beneath every member ribbon", () => {
    expect(source).toContain('<h2>All bets</h2>');
    expect(source).toContain('<label>Week <select');
    expect(source).toContain('wagerWeekOptions(data.activity.wagers.map((wager) => wager.weekStart), currentWeek)');
    expect(source).toContain('const currentWeek = weekStartOf(new Date()).toISOString();');
    expect(source).toContain('const week = selectedWeekOrCurrent(selectedWeek, weeks, currentWeek);');
    expect(source).toContain('<option value={ALL_WEEKS_VALUE}>All weeks</option>{weeks.map');
    expect(source).toContain('groupActivityMembers(data.activity.wagers, week)');
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

  it("keeps filter labels on one inline baseline so the checkbox aligns with the week select", () => {
    const styles = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");
    expect(styles).toContain('.activity-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }');
    expect(styles).toContain('.activity-filters label { flex-direction: row; align-items: center; gap: var(--space-1); margin: 0; }');
    expect(styles).toMatch(/\.activity-active-toggle \{[^}]*min-height:\s*44px/);
  });

  it("colors each selected leg from its own grade and preserves hidden tickets", () => {
    const sharedLine = readFileSync(resolve(import.meta.dirname, "../src/web/components/WagerLine.tsx"), "utf8");
    expect(source).toContain('import { WagerLine } from "../components/WagerLine"');
    expect(sharedLine).toContain('formatActivityLeg');
    expect(sharedLine).toContain('className={activityLegGradeClass(leg.grade)}');
    expect(sharedLine).toContain('<strong key={index}>{segment.text}</strong>');
    expect(source).toContain('Selection hidden until game time.');
  });

  it("colors wager P&L by result and includes the weekly member summary", () => {
    expect(source).toContain('activityWagerPerformanceClass');
    expect(source).toContain('<td className={activityWagerPerformanceClass(wager)}>{formatActivityWagerPerformance(wager)}</td>');
    expect(source).toContain('const performance = formatActivityPerformance(member.performanceMicros);');
    expect(source).toContain('{title ?? member.memberDisplayName}<small>{performance}</small>');
  });

  it("orders the compact mobile branch by kickoff anchor without relying on caller ordering", () => {
    expect(source).toContain('const wagers = compact ? sortWagersByAnchorTime(member.wagers) : sortWagersByStartTime(member.wagers);');
  });
});
