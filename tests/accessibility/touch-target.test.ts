import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../../src/web/styles.css"), "utf8");

describe("narrow-screen touch targets", () => {
  it("keeps mobile ribbon controls compact while preserving 44px action targets", () => {
    expect(css).toMatch(/@media \(max-width: 600px\)[^{]*\{[^@]*\.nav-bar a, \.nav-button\s*\{[^}]*min-height:\s*36px/);
    expect(css).toMatch(/@media \(max-width: 600px\)[^{]*\{[^@]*button:not\(\.nav-button\), \.primary-action, \.secondary-action\s*\{[^}]*min-height:\s*44px/);
  });

  it("uses smaller selected-pick text without shrinking the bet-slip remove target", () => {
    expect(css).toMatch(/\.tray-item-label\s*\{[^}]*font-size:\s*0\.85rem/);
    expect(css).toMatch(/@media \(max-width: 600px\)[^{]*\{[\s\S]*\.selection-tray-remove\s*\{[^}]*min-height:\s*44px/);
  });

  it("keeps the compact bet-slip Remove text control touch-sized on mobile", () => {
    expect(css).toMatch(/\.selection-tray-remove\s*\{[\s\S]*background:\s*transparent[\s\S]*text-decoration:\s*underline/);
    expect(css).toMatch(/@media \(max-width: 600px\)[^{]*\{[\s\S]*\.selection-tray-remove\s*\{[\s\S]*min-height:\s*44px/);
    expect(css).toContain('button:not(.primary-action):not(.nav-button):not(.selection-tray-remove):hover:not(:disabled)');
  });

  it("keeps the mobile amount input beside a wrapping matchup", () => {
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) 4.5rem auto;');
    expect(css).toContain('grid-template-areas: "selection risk remove";');
    expect(css).toMatch(/\.selection-tray-amount\s*\{[^}]*grid-area:\s*risk/);
    expect(css).not.toContain('grid-template-areas: "selection remove" "risk remove";');
  });
});
