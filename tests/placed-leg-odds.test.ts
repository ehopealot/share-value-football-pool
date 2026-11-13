import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { shapeActivityWagers } from "../src/durable/views";
import { WagerLine } from "../src/web/components/WagerLine";
import { ReadActivity } from "../src/contracts/http";

const leg = (market = "total", overrides = {}) => ({ event_id: "game", league: "nfl", canonical_book: "book", retrieved_at: "2026-09-01T00:00:00.000Z", policy_version: "v1", offer_version: "v1", market, selection: "over", original_line: 44, original_odds: -110, teaser_adjustment: null, adjusted_line: 44, event_starts_at: "2026-09-06T00:00:00.000Z", home_team: "Home", away_team: "Away", grade: null, result_version: null, ...overrides });
function shaped(type: string, legs = [leg()], owner = "viewer") {
  const sql = { exec(query: string) {
    if (query.includes("FROM wager JOIN")) return [{ id: "w", season_id: "s", owner_id: owner, owner_display_name: "Owner", type, risk_micros: "1000000", accepted_odds: 300, status: "won", ruleset_version: "v1", confirmed_at: "2026-09-01T00:00:00.000Z", activity_week_start: "2026-09-06T00:00:00.000Z" }];
    if (query.includes("FROM wager_leg")) return legs;
    return [];
  } } as unknown as SqlStorage;
  return shapeActivityWagers(sql, "viewer", new Date("2026-09-07T00:00:00.000Z")).wagers[0] as any;
}
const markup = (wager: any) => renderToStaticMarkup(createElement(WagerLine, { leg: wager.legs[0], wagerType: wager.type }));

describe("placed wager leg odds", () => {
  it.each(["spread", "total", "moneyline"])("shows +100 for every straight %s regardless of source odds", (market) => {
    const wager = shaped("straight", [leg(market, { original_odds: 220 })]);
    expect(wager.legs[0].placementOdds).toBe(100);
    expect(markup(wager)).toContain("(+100)");
  });
  it("prices a total using its hidden same-event companion, including after a push", () => {
    const wager = shaped("parlay", [leg(), leg("spread", { selection: "home", grade: "push", event_starts_at: "2026-09-08T00:00:00.000Z" })], "other");
    expect(wager.hiddenLegCount).toBe(1);
    expect(wager.legs).toHaveLength(1);
    expect(wager.legs[0].placementOdds).toBe(-133);
    expect(markup(wager)).toContain("(-133)");
    // The strict API schema retains the additional field, not just raw shaping output.
    const parsed = ReadActivity.parse({ commandVersion: "1", activity: { orders: [], wagers: [wager] } });
    expect(parsed.activity.wagers[0].legs?.[0].placementOdds).toBe(-133);
  });
  it.each([["spread", 100], ["total", 100], ["moneyline", 175]])("uses accepted parlay %s pricing", (market, odds) => {
    const wager = shaped("parlay", [leg(String(market), { original_odds: 175, grade: "win" })]);
    expect(wager.legs[0].placementOdds).toBe(odds);
    expect(markup(wager)).toContain(`(+${odds})`);
  });
  it("omits teaser odds and never guesses unavailable parlay odds", () => {
    const teaser = shaped("teaser");
    expect(teaser.legs[0]).not.toHaveProperty("placementOdds");
    teaser.legs[0].placementOdds = 100;
    expect(markup(teaser)).not.toContain("(+100)");
    const parlay = shaped("parlay");
    delete parlay.legs[0].placementOdds;
    expect(markup(parlay)).not.toContain("(+100)");
  });
});
