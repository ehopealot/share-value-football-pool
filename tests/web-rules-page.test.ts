import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { RulesContent } from "../src/web/pages/RulesPage";

const season = (state: "active" | "closed", label: string, rulesetVersion = "SHARE_POOL_2026_V1") => ({ id: `${state}-season`, label, state, rulesetVersion, createdAt: "2026-01-01T00:00:00.000Z", openedAt: "2026-01-02T00:00:00.000Z", closedAt: state === "closed" ? "2027-02-15T00:00:00.000Z" : null, ...(state === "closed" ? { closeReason: "complete" } : {}), defaultOrderMode: null, defaultOrderAmountMicros: null, floatMicros: "0", notionalValueMicros: "0" });
const view = (active: boolean, closed: boolean) => ({ activeSeason: active ? season("active", "Active 2026") : null, latestClosedSeason: closed ? season("closed", "Closed 2025") : null });
const board = (status: "current" | "stale" | "provider-error" | "no-offer") => ({
  offers: status === "current" ? [
    { eventId: "event-1", league: "nfl", homeTeam: "Home", awayTeam: "Away", startsAt: "2030-09-01T12:00:00.000Z", market: "spread", canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", offerVersion: "v1", policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110, point: -3 }] },
    { eventId: "event-2", league: "ncaaf", homeTeam: "College Home", awayTeam: "College Away", startsAt: "2030-09-01T13:00:00.000Z", market: "total", canonicalBook: "FanDuel", retrievedAt: "2030-09-01T10:02:00.000Z", offerVersion: "v2", policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Over", price: -110, point: 45 }] }
  ] : [],
  feed: { status, message: status === "current" ? "Odds are up to date." : status === "stale" ? "Current odds are stale; new bets are disabled." : status === "provider-error" ? "Odds provider error; accepted bets remain intact." : "No current odds are available.", lastPolledAt: "2030-09-01T10:03:00.000Z", lastSuccessAt: status === "provider-error" ? "2030-09-01T09:58:00.000Z" : "2030-09-01T10:03:00.000Z" }
});
const render = (poolView: any, oddsBoard: any) => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(RulesContent, { slug: "pool", view: poolView, board: oddsBoard })));

describe("truthful rules and feed presentation", () => {
  it("prefers the authoritative active season and shows feed status", () => {
    const html = render(view(true, true), board("current"));
    expect(html).toContain("Active 2026");
    expect(html).not.toContain("Closed 2025");
    expect(html).toContain("active");
    expect(html).toContain("SHARE_POOL_2026_V1");
    expect(html).toContain("Last polled");
    expect(html).toContain("2030-09-01T10:03:00.000Z");
  });

  it("falls back to latest closed season and names stale, provider-error, no-offer, and no-season states", () => {
    expect(render(view(false, true), board("stale"))).toContain("Closed 2025");
    expect(render(view(false, true), board("stale"))).toContain("stale");
    expect(render(view(false, true), board("provider-error"))).toContain("provider-error");
    expect(render(view(false, true), board("provider-error"))).toContain("2030-09-01T09:58:00.000Z");
    expect(render(view(false, true), board("no-offer"))).toContain("no-offer");
    expect(render(view(false, false), board("no-offer"))).toContain("No active or closed season is available");
  });

  it("publishes the complete fixed teaser and parlay policies", () => {
    const html = render(view(true, false), board("current"));
    expect(html).toContain("10-point teasers require exactly 3 legs");
    expect(html).toContain("Regular teasers allow 2–6 legs");
    expect(html).toContain("7 (legacy only)");
    expect(html).toContain("seven-leg row applies only to previously accepted legacy tickets");
    expect(html).toContain("New teaser tickets are capped at six legs");
    for (const price of ["-120", "+150", "+235", "+350", "+550", "+800"]) expect(html).toContain(price);
    for (const text of ["PARLAY_2026_V1", "2–6 legs", "spreads, totals, and moneylines", "one spread or moneyline", "-133", "all legs are final", "Pushes and voids are removed and surviving legs are repriced"]) expect(html).toContain(text);
  });

  it("renders the persisted selected-season ruleset and refuses an unknown table", () => {
    const unknownView = { activeSeason: season("active", "Future", "FUTURE_RULES_V9"), latestClosedSeason: season("closed", "Old") };
    const html = render(unknownView, board("current"));
    expect(html).toContain("FUTURE_RULES_V9");
    expect(html).toContain("Unsupported ruleset");
    expect(html).not.toContain("Teaser payouts: SHARE_POOL_2026_V1");
    expect(html).not.toContain("Fixed system teaser prices");
  });
});
