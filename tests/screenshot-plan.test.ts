import { describe, expect, it } from "vitest";

// @ts-expect-error finish scripts are plain ESM and intentionally have no declaration file.
const { screenshotRoutes, screenshotViewports } = await import("../scripts/screenshot-plan.mjs");

describe("finish screenshot plan", () => {
  it("pins each selected finish-review route, its fixture-derived heading, and each captured viewport", () => {
    expect(screenshotRoutes("sentinel-pool", "sentinel-season-id", "Sentinel Pool Name", "Sentinel Season Label")).toEqual([
      { name: "overview", path: "/p/sentinel-pool/overview", heading: "Sentinel Pool Name" },
      { name: "odds", path: "/p/sentinel-pool/odds", heading: "Odds board" },
      { name: "teaser", path: "/p/sentinel-pool/teaser", heading: "Teaser builder" },
      { name: "my-wagers", path: "/p/sentinel-pool/my-wagers", heading: "My Bets" },
      { name: "standings", path: "/p/sentinel-pool/standings", heading: "Standings" },
      { name: "activity", path: "/p/sentinel-pool/activity", heading: "Activity" },
      { name: "rules", path: "/p/sentinel-pool/rules", heading: "Pool rules" },
      { name: "orders", path: "/p/sentinel-pool/admin/orders", heading: "Share orders" },
      { name: "history", path: "/p/sentinel-pool/history/sentinel-season-id", heading: "Archived season: Sentinel Season Label" }
    ]);
    expect(screenshotViewports).toEqual([{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }]);
  });
});
