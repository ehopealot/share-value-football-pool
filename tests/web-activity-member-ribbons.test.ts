import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemberActivitySection } from "../src/web/pages/ActivityPage";

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);
const member = {
  memberId: "ucla",
  memberDisplayName: "Bruin",
  performanceMicros: "500000000",
  wagers: [{
    wagerId: "wager", seasonId: "season", memberId: "ucla", memberDisplayName: "Bruin", type: "straight", status: "won", confirmedAt: "2026-09-01T00:00:00.000Z", weekStart: "2026-09-01T04:00:00.000Z", performanceMicros: "500000000", riskMicros: "100000000", acceptedOdds: 150,
    legs: [{ eventId: "game", league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-09-01T00:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", market: "spread", selection: "away", originalLine: "-7.5", originalOdds: -110, eventStartsAt: "2026-09-06T20:00:00.000Z", awayTeam: "UCLA", homeTeam: "Arizona" }]
  }]
};

describe("Activity member ribbons", () => {
  it("places a member's nickname and weekly P&L above a compact member-free wager table", () => {
    const html = render(createElement(MemberActivitySection, { member: member as any }));

    expect(html).toContain('<section class="activity-member-section">');
    expect(html).toContain('<h3 class="activity-member-ribbon">Bruin<small>+500.00 shares</small></h3>');
    expect(html).toContain('<th>Start</th><th>Wager</th><th>Staked</th><th>P&amp;L</th>');
    expect(html).not.toContain('<th>Member</th>');
    expect(html).toContain("UCLA");
  });
});
