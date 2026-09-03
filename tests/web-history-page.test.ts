import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ArchivedRulesetGuidance, EventResultsTable, WagerRulesetGuidance } from "../src/web/pages/HistoryPage";

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, {}, element));

describe("archived history presentation", () => {
  it("links the supported persisted ruleset to its matching immutable rules surface", () => {
    const html = render(createElement(ArchivedRulesetGuidance, { slug: "pool", rulesetVersion: "SHARE_POOL_2026_V1" }));
    expect(html).toContain("SHARE_POOL_2026_V1");
    expect(html).toContain('href="/p/pool/rules#teaser-rules-heading"');
    expect(html).toContain("This archived version remains authoritative");
    expect(html).not.toContain("Unsupported archived ruleset");
  });

  it("guides a parlay by its wager ruleset rather than the archived season teaser ruleset", () => {
    const html = render(createElement(WagerRulesetGuidance, { slug: "pool", wager: { wagerId: "parlay", type: "parlay", rulesetVersion: "PARLAY_2026_V1" } }));
    expect(html).toContain("PARLAY_2026_V1");
    expect(html).toContain('href="/p/pool/rules#parlay-rules-heading"');
    expect(html).toContain("independently of the season teaser ruleset");
  });

  it("warns that an unsupported archived ruleset must not use the current payout table", () => {
    const html = render(createElement(ArchivedRulesetGuidance, { slug: "pool", rulesetVersion: "SHARE_POOL_2025_V9" }));
    expect(html).toContain("Unsupported archived ruleset: SHARE_POOL_2025_V9");
    expect(html).toContain("do not use the current Rules page payout table for this season");
    expect(html).not.toContain('href="/p/pool/rules');
  });

  it("renders every immutable result identity when one event has multiple corrections", () => {
    const html = render(createElement(EventResultsTable, { results: [
      { eventId: "event-1", observedAt: "2030-01-01T00:00:00.000Z", result: { eventId: "event-1", league: "nfl", status: "final", homeScore: 17, awayScore: 14, correctionVersion: "provider-1" } },
      { eventId: "event-1", observedAt: "2030-01-02T00:00:00.000Z", result: { eventId: "event-1", league: "nfl", status: "final", homeScore: 20, awayScore: 14, correctionVersion: "provider-2" } }
    ] }));
    expect(html).toContain("League");
    expect(html).toContain("Correction version");
    expect(html).toContain("provider-1");
    expect(html).toContain("provider-2");
    expect(html.match(/<td>event-1<\/td>/g)).toHaveLength(2);
  });
});
