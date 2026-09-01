import { describe, expect, it } from "vitest";

// @ts-expect-error finish scripts are plain ESM and intentionally have no declaration file.
const { screenshotRoutes } = await import("../scripts/screenshot-plan.mjs");

describe("finish screenshot plan", () => {
  it("captures authenticated table, state, and history surfaces instead of placeholder demo routes", () => {
    const routes = screenshotRoutes("finish-review", "season-id");
    expect(routes.map((route: { name: string }) => route.name)).toEqual(["overview", "odds", "teaser", "my-wagers", "standings", "activity", "rules", "orders", "history"]);
    expect(routes.every((route: { path: string }) => !route.path.includes("/demo/"))).toBe(true);
  });
});
