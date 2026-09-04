import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemberActivitySection } from "../src/web/pages/ActivityPage";

const styles = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");

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
    expect(html).toContain('<colgroup><col class="activity-start-column"/><col class="activity-wager-column"/><col class="activity-staked-column"/><col class="activity-pnl-column"/></colgroup>');
    expect(html).toContain('<th>Start</th><th>Wager</th><th>Staked</th><th>P&amp;L</th>');
    expect(html).not.toContain('<th>Member</th>');
    expect(styles).toMatch(/\.activity-table\s*\{[^}]*table-layout:\s*fixed/);
    expect(styles).toMatch(/\.activity-start-column\s*\{[^}]*width:\s*7rem/);
    expect(styles).toMatch(/\.activity-wager-column\s*\{[^}]*width:\s*52%/);
    expect(styles).toMatch(/\.activity-staked-column\s*\{[^}]*width:\s*16%/);
    expect(styles).toMatch(/\.activity-pnl-column\s*\{[^}]*width:\s*12%/);
    expect(styles).toMatch(/\.activity-member-section \.activity-wager-lines > span\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/);
    expect(styles).toContain('@media (max-width: 600px) { .activity-table { min-width: 35rem; font-size: 0.9rem; } .activity-table th, .activity-table td { padding: 0.3rem 0.4rem; } .activity-wager-column { width: 50%; } .activity-pnl-column { width: 14%; } }');
    expect(html).toContain("UCLA");
  });

  it("keeps multi-leg matchups in one table row while showing a kickoff for each leg", () => {
    const multiLegMember = { ...member, wagers: [{ ...member.wagers[0], type: "parlay", legs: [...member.wagers[0].legs, { ...member.wagers[0].legs[0], eventId: "game-2", awayTeam: "Oregon", homeTeam: "Washington", eventStartsAt: "2026-09-07T20:00:00.000Z" }] }] };
    const html = render(createElement(MemberActivitySection, { member: multiLegMember as any }));

    expect(html.match(/<tr/g)).toHaveLength(2);
    expect(html).not.toContain("activity-wager-leg-row");
    expect(html).toContain('<td><div class="activity-wager-lines wager-start-times">');
    expect(html.match(/class="wager-start-time"/g)).toHaveLength(2);
    expect(styles).toContain('.activity-member-section .wager-start-times > .wager-start-time { white-space: nowrap; overflow-wrap: normal; }');
  });
});
