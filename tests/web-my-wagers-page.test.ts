import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/MyWagersPage.tsx"), "utf8");
const styles = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");

describe("My wagers page", () => {
  it("uses the compact Activity-style wager, stake, payout, and P&L layout in each status section", () => {
    expect(source).toMatch(/sortWagersByStartTime\(data\.wagers\.filter\(\(w: any\) => w\.status === "open"\)\)/);
    expect(source).toMatch(/sortWagersByStartTime\(data\.wagers\.filter\(\(w: any\) => w\.status !== "open"\)\)/);
    expect(source).toContain('<th>Start</th><th>Wager</th><th>Staked</th><th>Payout</th><th>P&amp;L</th>');
    expect(source).toContain('displayWagerStartTimes(wager)');
    expect(source).toContain('formatActivityLeg(leg)');
    expect(source).toContain('<strong key={index} className={activitySelectedOutcomeClass(wager)}>{segment.text}</strong>');
    expect(source).toContain('<span className="activity-staked">{stake.amount} <small className="activity-staked-odds">{stake.odds}</small></span>');
    expect(source).toContain('<td className={activityWagerPerformanceClass(wager)}>{formatActivityWagerPerformance(wager)}</td>');
  });

  it("keeps each wager leg on its own line without splitting selected and unselected fragments", () => {
    expect(styles).toContain('.wager-legs > span { display: block; }');
  });
});
