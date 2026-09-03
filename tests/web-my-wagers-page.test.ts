import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/MyWagersPage.tsx"), "utf8");

describe("My wagers page", () => {
  it("orders each status section by kickoff and shows P&L instead of odds", () => {
    expect(source).toMatch(/sortWagersByStartTime\(data\.wagers\.filter\(\(w: any\) => w\.status === "open"\)\)/);
    expect(source).toMatch(/sortWagersByStartTime\(data\.wagers\.filter\(\(w: any\) => w\.status !== "open"\)\)/);
    expect(source).toContain('<th>Start</th><th>Matchup</th><th>Pick</th><th>P&amp;L</th><th>Risk</th><th>Payout</th>');
    expect(source).toContain('displayWagerStartTime(wager)');
    expect(source).toContain('formatActivityPerformance(wager.performanceMicros)');
  });
});
