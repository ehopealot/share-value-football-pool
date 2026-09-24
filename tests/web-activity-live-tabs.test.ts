import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PoolNavigation } from "../src/web/components/Layout";

const root = resolve(import.meta.dirname, "..");
const router = readFileSync(resolve(root, "src/web/router.tsx"), "utf8");
const view = {
  commandVersion: "1",
  pool: { poolId: "pool-id", slug: "pool", name: "Office pool", commissionerId: "commissioner", signupsOpen: true, maxSideBetMicros: "800000000", commissionerNotice: null, commissionerRules: null },
  activeSeason: null, nextDraftSeason: null, latestClosedSeason: null,
  currentMember: { memberId: "member", role: "member" as const, seasonBalances: [], hasUnreadBoard: false },
  members: [], commissioner: null
};

describe("Activity and Live games navigation", () => {
  it("places Activity and Live beside each other in pool navigation", () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/p/pool/activity"] }, createElement(PoolNavigation, { slug: "pool", view })));

    expect(markup).toContain('href="/p/pool/activity"');
    expect(markup).toContain('href="/p/pool/live"');
    expect(markup.indexOf('href="/p/pool/activity"')).toBeLessThan(markup.indexOf('href="/p/pool/live"'));
  });

  it("registers the Live route with the shared Live games page", () => {
    expect(router).toContain('import { ActivityPage, LiveGamesPage } from "./pages/ActivityPage"');
    expect(router).toContain('path="/p/:slug/live" element={<LiveGamesPage/>}');
  });
});
