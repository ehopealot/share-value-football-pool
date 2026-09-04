import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/MyWagersPage.tsx"), "utf8");
const styles = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");

describe("My wagers page", () => {
  it("uses the compact Activity-style wager, stake, payout, and P&L layout in each status section", () => {
    expect(source).toMatch(/sortWagersByStartTime\(data\.wagers\.filter\(\(w\) => w\.status === "open"\)\)/);
    expect(source).toMatch(/sortWagersByStartTime\(data\.wagers\.filter\(\(w\) => w\.status !== "open"\)\)/);
    expect(source).toContain('<h2 className="activity-member-ribbon">{title}</h2>');
    expect(source).toContain('<table className="activity-table"><colgroup><col className="activity-start-column"/><col className="activity-wager-column"/><col className="activity-staked-column"/><col className="activity-payout-column"/><col className="activity-pnl-column"/></colgroup>');
    expect(source).toContain('<th>Start</th><th>Wager</th><th>Staked</th><th>Payout</th><th>P&amp;L</th>');
    expect(source).toContain('displayWagerStartTimes(wager)');
    expect(source).toContain('formatActivityLeg(leg)');
    expect(source).toContain('const gradeClass = leg.grade === "loss" ? "activity-leg-loss" : leg.grade === "win" ? "activity-leg-win" : "activity-leg-neutral";');
    expect(source).toContain('className={gradeClass}');
    expect(source).toContain('<strong key={index}>{segment.text}</strong>');
    expect(source).not.toContain('activitySelectedOutcomeClass(wager)');
    expect(source).not.toContain('activityLegTimingClass(leg)');
    expect(source).toContain('<span className="activity-staked">{stake.amount} <small className="activity-staked-odds">{stake.odds}</small></span>');
    expect(source).toContain('rowSpan={legs.length}');
    expect(source).toContain('className={index ? "activity-wager-leg-row" : undefined}');
    expect(source).toContain('className="wager-start-time"');
    expect(source).toContain('<td className={activityWagerPerformanceClass(wager)} rowSpan={legs.length}>{formatActivityWagerPerformance(wager)}</td>');
  });

  it("uses a My Bets page title while section names appear only in their ribbons", () => {
    expect(source).toContain('<h1>My Bets</h1>');
    expect(source).not.toContain('<h2>Open bets</h2>');
    expect(source).not.toContain('<h2>Settled bets</h2>');
  });

  it("keeps My Bets kickoffs aligned with their wager lines", () => {
    expect(styles).toContain('.wager-start-time { display: block; white-space: nowrap; }');
    expect(styles).toContain('.my-wagers-page .activity-leg-loss, .my-wagers-page .activity-leg-win, .my-wagers-page .activity-leg-neutral { white-space: nowrap; }');
    expect(styles).toContain('.activity-start-column { width: 7rem; }');
    expect(styles).not.toContain('.my-wagers-page .activity-start-column');
    expect(styles).toContain('.my-wagers-page .activity-wager-column { width: 52%; }');
    expect(styles).toMatch(/^\.activity-leg-loss \{ color: #b42318; \}$/m);
    expect(styles).toMatch(/^\.activity-leg-win \{ color: #137333; \}$/m);
    expect(styles).toMatch(/^\.activity-leg-neutral \{ color: var\(--ink\); \}$/m);
  });
});
