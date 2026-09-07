import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadActivity } from "../src/contracts/http";
import { AdminCorrectionsPage } from "../src/web/pages/AdminCorrectionsPage";

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial: unknown) => [hooks.values[hooks.cursor++] ?? initial, () => {}]
}));
vi.mock("react-router", () => ({ useParams: () => ({ slug: "pool" }), Link: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/web/components/Layout", () => ({ Layout: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/web/admin-command", () => ({ useFrozenAdminCommand: () => ({ pending: false, retire: () => {}, run: vi.fn() }) }));

type Wager = ReadActivity["activity"]["wagers"][number];
const leg: NonNullable<Wager["legs"]>[number] = {
  eventId: "event-spread", league: "ncaaf", canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z",
  policyVersion: "policy", offerVersion: "offer", market: "spread", selection: "away", originalLine: "-7.5", originalOdds: -110,
  eventStartsAt: "2030-09-07T20:00:00.000Z", awayTeam: "Texas Longhorns", homeTeam: "Alabama Crimson Tide", grade: "win"
};
const wager = (overrides: Partial<Wager> = {}): Wager => ({
  wagerId: "wager-straight", seasonId: "season", memberId: "alice", memberDisplayName: "Alice", type: "straight", status: "won",
  confirmedAt: "2030-09-01T10:00:00.000Z", weekStart: "2030-09-03T04:00:00.000Z", performanceMicros: "10000000",
  riskMicros: "10000000", acceptedOdds: 100, legs: [leg], ...overrides
});
const view = { activeSeason: { id: "season" }, currentMember: { role: "commissioner" } };
function render(wagers: Wager[], audit: Record<string, unknown> = {}) {
  hooks.cursor = 0;
  hooks.values = [{ activity: { wagers } }, view, { wagers, settlements: [], wagerCorrections: [], ...audit }];
  return renderToStaticMarkup(createElement(AdminCorrectionsPage));
}
beforeEach(() => { hooks.cursor = 0; hooks.values = []; });

describe("correction wager identification", () => {
  it("uses standings-sized mobile tables and contains scrolling for history", () => {
    const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
    const html = render([wager()], { settlements: [{ id: "settlement", wagerId: "wager-straight", outcome: "win", resultVersion: "version", reversalOf: null, reason: null }] });
    expect(html).toContain('class="corrections-page"');
    expect(html.match(/class="table-scroll"/g)).toHaveLength(2);
    expect(css).toMatch(/@media \(max-width: 600px\)\s*\{[^}]*\.corrections-page table\s*\{\s*font-size: 0\.875rem;/);
    expect(css).toContain(".corrections-page th, .corrections-page td { padding: 0.35rem;");
    expect(css).toContain(".corrections-page td { overflow-wrap: anywhere;");
  });

  it("shows selected teams, lines, grade colors, kickoff and stake rather than just wager type", () => {
    const html = render([wager()]);
    expect(html).toContain("<strong>Texas (-7.5)</strong>");
    expect(html).toContain(" at Alabama");
    expect(html).toContain('class="activity-leg-win"');
    expect(html).toMatch(/datetime="2030-09-07T20:00:00.000Z"/i);
    expect(html).toContain('class="activity-staked"');
    expect(html).toContain("+100");
    expect(html).toContain("Alice");
    expect(html).toContain("event-spread");
    expect(html).toContain("Void with reason");
    expect(html).toContain("Regrade with reason");
  });

  it("shows every parlay and teaser leg with its selected total or adjusted line", () => {
    const html = render([wager({ type: "parlay", status: "lost", legs: [leg, { ...leg, eventId: "event-total", market: "total", selection: "under", originalLine: "47.5", grade: "loss" }] }),
      wager({ wagerId: "wager-teaser", type: "teaser", status: "refunded", legs: [{ ...leg, adjustedLine: "-1.5", grade: "push" }] })]);
    expect(html).toContain("<strong>U47.5</strong>");
    expect(html).toContain("<strong>Texas (-1.5)</strong>");
    expect(html).toContain('class="activity-leg-loss"');
    expect(html).toContain('class="activity-leg-push"');
  });

  it("renders moneylines without inventing a spread and orders multi-leg kickoffs", () => {
    const html = render([wager({ type: "parlay", legs: [
      { ...leg, eventId: "later", eventStartsAt: "2030-09-08T20:00:00.000Z", market: "moneyline", selection: "home", originalLine: undefined },
      leg
    ] })]);
    expect(html).toContain("<strong>Alabama</strong>");
    expect(html.indexOf("Texas (-7.5)")).toBeLessThan(html.indexOf("<strong>Alabama</strong>"));
    expect(html).not.toContain("Alabama (+");
  });

  it("keeps unrevealed legs out of a partially visible parlay", () => {
    const html = render([wager({ type: "parlay", hiddenLegCount: 2 })]);
    expect(html).toContain("2 other selections hidden until game time.");
    expect(html.match(/class="correction-wager-leg"/g)).toHaveLength(1);
  });

  it("identifies settled history wagers while keeping immutable outcomes and IDs", () => {
    const html = render([], {
      wagers: [wager({ seasonId: "closed-season" })],
      settlements: [{ id: "settlement", wagerId: "wager-straight", outcome: "loss", resultVersion: "original-result", reversalOf: null, reason: "Disputed score" },
        { id: "missing", wagerId: "unavailable-wager", outcome: "reversal", resultVersion: "old-result", reversalOf: "old-settlement", reason: "Correction" }]
    });
    expect(html).toContain("<strong>Texas (-7.5)</strong>");
    expect(html).toContain("Current wager details");
    expect(html).toContain("wager-straight");
    expect(html).toContain("Alice");
    expect(html).toContain("<td>loss</td>");
    expect(html).toContain("original-result");
    expect(html).toContain("unavailable-wager");
    expect(html).toContain("old-settlement");
  });

  it("denies non-commissioners even when read data is loaded", () => {
    hooks.values = [{ activity: { wagers: [wager()] } }, { ...view, currentMember: { role: "member" } }, { wagers: [], settlements: [], wagerCorrections: [] }];
    const html = renderToStaticMarkup(createElement(AdminCorrectionsPage));
    expect(html).toContain("Only the commissioner can correct eligible active-season wagers.");
    expect(html).not.toContain("Texas");
    expect(html).not.toContain("Regrade with reason");
  });

  it("preserves hidden-selection messaging and does not expose audit-only legs in eligible rows", () => {
    const hidden = wager({ status: "open", legs: undefined, riskMicros: undefined, acceptedOdds: undefined });
    const html = render([hidden], { wagers: [wager()] });
    expect(html).toContain("Selection hidden until game time.");
    expect(html).not.toContain("Texas");
    expect(html).not.toContain("+100");
  });
});
