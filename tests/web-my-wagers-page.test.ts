import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/MyWagersPage.tsx"), "utf8");
const styles = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");

describe("My wagers page", () => {
  it("uses the compact Activity-style wager, stake, payout, and P&L layout in each status section", () => {
    expect(source).toMatch(/sortWagersByStartTime\(data\.wagers\.filter\(\(w\) => w\.status === "open"\)\)/);
    expect(source).toMatch(/sortWagersByStartTime\(data\.wagers\.filter\(\(w\) => w\.status !== "open"\)\)/);
    expect(source).toContain('<th>Start</th><th>Wager</th><th>Staked</th><th>Payout</th><th>P&amp;L</th>');
    expect(source).toContain('displayWagerStartTimes(wager)');
    expect(source).toContain('formatActivityLeg(leg)');
    expect(source).toContain('const gradeClass = leg.grade === "loss" ? "activity-leg-loss" : leg.grade === "win" ? "activity-leg-win" : "activity-leg-neutral";');
    expect(source).toContain('className={gradeClass}');
    expect(source).toContain('<strong key={index}>{segment.text}</strong>');
    expect(source).not.toContain('activitySelectedOutcomeClass(wager)');
    expect(source).not.toContain('activityLegTimingClass(leg)');
    expect(source).toContain('<span className="activity-staked">{stake.amount} <small className="activity-staked-odds">{stake.odds}</small></span>');
    expect(source).toContain('<td className={activityWagerPerformanceClass(wager)}>{formatActivityWagerPerformance(wager)}</td>');
  });

  it("does not repeat the page title above the My Bets table", () => {
    expect(source).not.toContain('<h1>My wagers</h1>');
  });

  it("keeps each wager leg on its own line without splitting selected and unselected fragments", () => {
    expect(styles).toContain('.wager-legs > span { display: block; white-space: nowrap; }');
    expect(styles).toMatch(/^\.activity-leg-loss \{ color: #b42318; \}$/m);
    expect(styles).toMatch(/^\.activity-leg-win \{ color: #137333; \}$/m);
    expect(styles).toMatch(/^\.activity-leg-neutral \{ color: var\(--ink\); \}$/m);
  });
});
