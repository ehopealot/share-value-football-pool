import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pickAtLine, teaserSelectedDetail } from "../src/web/pages/TeaserPage";

const oddsPage = readFileSync(resolve(import.meta.dirname, "../src/web/pages/OddsPage.tsx"), "utf8");
const teaserPage = readFileSync(resolve(import.meta.dirname, "../src/web/pages/TeaserPage.tsx"), "utf8");
const parlayPage = readFileSync(resolve(import.meta.dirname, "../src/web/pages/ParlayPage.tsx"), "utf8");

describe("builder selected-leg displays", () => {
  it("embeds the selected pick in odds, teaser, and parlay matchups", () => {
    expect(oddsPage).toContain('className="tray-item-label"><SelectedLegDisplay');
    expect(oddsPage).toContain('<th>Matchup</th><th>Odds</th><th>Risk</th><th>To win</th>');
    expect(teaserPage).toContain('<th>Matchup</th><th>Original line</th><th>Adjustment</th><th>Action</th>');
    expect(teaserPage).toContain('<SelectedLegDisplay league={leg.league}');
    expect(parlayPage).toContain('const parlayLegTableColumns = ["Matchup", "Market", "Action"] as const;');
    expect(parlayPage).toContain('<SelectedLegDisplay league={leg.league}');
  });

  it("uses concise names and adjusted details in the teaser matchup", () => {
    const away = { league: "ncaaf", awayTeam: "Texas Longhorns", homeTeam: "Oklahoma Sooners", market: "spread", selection: "away", originalLine: 3, adjustedLine: undefined } as any;
    const total = { ...away, market: "total", selection: "over", originalLine: 44.5 };

    expect(pickAtLine(away, 3)).toBe("Texas +3");
    expect(teaserSelectedDetail(away, 6)).toBe("+9");
    expect(teaserSelectedDetail(total, 6)).toBe("38.5");
  });
});
