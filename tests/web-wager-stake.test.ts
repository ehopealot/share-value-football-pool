import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReadActivity } from "../src/contracts/http";
import { MultiWagerLegs, WagerStake } from "../src/web/components/WagerStake";

type Wager = ReadActivity["activity"]["wagers"][number];
const leg: NonNullable<Wager["legs"]>[number] = {
  eventId: "game", league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-09-01T00:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", market: "spread", selection: "away", originalLine: "-7.5", originalOdds: -110, eventStartsAt: "2026-09-06T20:00:00.000Z", awayTeam: "Seattle Seahawks", homeTeam: "Arizona Cardinals"
};
const wager: Wager = {
  wagerId: "ticket", seasonId: "season", memberId: "member", memberDisplayName: "Member", type: "parlay", status: "open", confirmedAt: "2026-09-01T00:00:00.000Z", weekStart: "2026-09-01T07:00:00.000Z", performanceMicros: "0", riskMicros: "10000000", acceptedOdds: 300, legs: [leg]
};
const stake = (changes: Partial<Wager> = {}) => renderToStaticMarkup(createElement(WagerStake, { wager: { ...wager, ...changes } }));
const details = (changes: Partial<Wager> = {}) => renderToStaticMarkup(createElement(MultiWagerLegs, { wager: { ...wager, ...changes } }));

describe("multi stake details", () => {
  it("keeps tappable stakes styled as plain text", () => {
    const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
    const rule = css.match(/button\.wager-stake-button\s*\{([^}]+)\}/)?.[1];
    expect(rule).toContain("color: var(--ink)");
    expect(rule).toContain("text-decoration: none");
    expect(rule).toContain("background: transparent");
  });
  it("underlines both stake amounts on hover without a background fill", () => {
    const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
    expect(css).toContain("button.wager-stake-button:hover { background: transparent; }");
    expect(css).toContain("button.wager-stake-button:hover, button.wager-stake-button:hover .activity-staked-odds { text-decoration: underline; text-underline-offset: 2px; }");
  });
  it.each(["parlay", "teaser"] as const)("makes a %s stake a labeled dialog button without mounting hidden details", (type) => {
    const html = stake({ type });
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain(`aria-label="View ${type} legs: 10 shares at +300"`);
    expect(html).toContain('10 <small class="activity-staked-odds">+300</small>');
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("Seattle");
  });

  it("keeps straight stakes as plain text and preserves unavailable-term fallbacks", () => {
    expect(stake({ type: "straight" })).toBe('<span class="activity-staked">10 <small class="activity-staked-odds">+300</small></span>');
    expect(stake({ riskMicros: undefined })).toBe("");
    expect(renderToStaticMarkup(createElement(WagerStake, { wager: { ...wager, riskMicros: undefined }, fallback: "—" }))).toBe("—");
    const hiddenOdds = stake({ acceptedOdds: undefined });
    expect(hiddenOdds).not.toContain("+300");
    expect(hiddenOdds).not.toContain("activity-staked-odds");
  });

  it("passes the wager type through to placement-odds leg displays", () => {
    const legs = [{ ...leg, placementOdds: 100 }];
    expect(details({ type: "parlay", legs })).toContain(" (+100)</span>");
    expect(details({ type: "teaser", legs })).not.toContain(" (+100)</span>");
  });

  it("shows each parlay leg in kickoff order without source odds", () => {
    const html = details({ legs: [leg, { ...leg, eventId: "early", market: "moneyline", originalLine: undefined, originalOdds: 145, eventStartsAt: "2026-09-06T18:00:00.000Z", awayTeam: "Denver Broncos" }] });
    expect(html).not.toContain("Source odds");
    expect(html).toContain("(-7.5)");
    expect(html.indexOf("Denver")).toBeLessThan(html.indexOf("Seattle"));
  });

  it.each([
    ["spread", "away", "-7.5", "-1.5", "Spread: -7.5 → -1.5 (+6 points)"],
    ["spread", "home", "3", "9.5", "Spread: +3 → +9.5 (+6.5 points)"],
    ["total", "over", "44", "37", "Total: 44 → 37 (-7 points)"],
    ["total", "under", "44", "51", "Total: 44 → 51 (+7 points)"],
    ["spread", "away", "-6", "0", "Spread: -6 → 0 (+6 points)"]
  ])("shows %s %s original and adjusted lines", (market, selection, originalLine, adjustedLine, expected) => {
    const html = details({ type: "teaser", legs: [{ ...leg, market, selection, originalLine, adjustedLine, teaserAdjustment: "6" }] });
    expect(html).toContain(expected);
    expect(html).not.toContain("Source odds");
  });

  it("does not invent missing or invalid teaser lines", () => {
    for (const originalLine of [undefined, "", "not-a-line"]) {
      const html = details({ type: "teaser", legs: [{ ...leg, originalLine, adjustedLine: "7" }] });
      expect(html).toContain("Line adjustment unavailable.");
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("→");
    }
  });

  it("shows only supplied legs and accounts for hidden selections", () => {
    expect(details({ hiddenLegCount: 2 })).toContain("2 selections hidden until game time.");
    expect(details({ hiddenLegCount: 1 })).toContain("1 selection hidden until game time.");
    const html = details({ legs: undefined, hiddenLegCount: 3 });
    expect(html).toContain("3 selections hidden until game time.");
    expect(html).not.toContain("Seattle");
    expect(html).not.toContain("Source odds");
    expect(details({ legs: [] })).toContain("Selections hidden until game time.");
  });
});
