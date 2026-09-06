import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");

describe("mobile wager tables", () => {
  it("uses compact phone-specific dimensions for My Bets and Activity", () => {
    expect(css).toMatch(/@media \(max-width: 600px\) \{[\s\S]*?\.activity-table \{ min-width: 30rem; font-size: 0\.78rem; \}/);
    expect(css).toContain(".my-wagers-page .activity-table { min-width: 32rem; }");
    expect(css).toContain(".activity-start-column { width: 5.25rem; }");
    expect(css).toContain(".activity-table th, .activity-table td { padding: 0.2rem 0.25rem; }");
    expect(css).toContain(".my-wagers-page .activity-wager-column { overflow-wrap: anywhere; }");
    expect(css).toContain(".my-wagers-page .activity-leg-loss, .my-wagers-page .activity-leg-win, .my-wagers-page .activity-leg-push, .my-wagers-page .activity-leg-neutral { white-space: normal; }");
    expect(css).toContain(".wager-date-row { display: table-row; }");
    expect(css).toContain(".wager-start-time { display: none; }");
    expect(css).toContain(".wager-start-time-mobile { display: block; white-space: nowrap; }");
  });
});
