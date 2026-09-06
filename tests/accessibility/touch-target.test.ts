import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../../src/web/styles.css"), "utf8");
const normalizePrelude = (prelude: string) => prelude.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
const directRules = (source: string) => {
  const rules: { prelude: string; body: string }[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("{", cursor);
    if (open < 0) break;
    let depth = 1;
    let close = open + 1;
    while (close < source.length && depth > 0) {
      if (source[close] === "{") depth++;
      if (source[close] === "}") depth--;
      close++;
    }
    if (depth !== 0) throw new Error(`Unclosed CSS block: ${source.slice(cursor, open).trim()}`);
    rules.push({ prelude: normalizePrelude(source.slice(cursor, open)), body: source.slice(open + 1, close - 1) });
    cursor = close;
  }
  return rules;
};
const topLevelRules = directRules(css);
const mobileBlocks = topLevelRules.filter((rule) => rule.prelude === "@media (max-width: 600px)").map((rule) => rule.body);
const exactRule = (rules: { prelude: string; body: string }[], selector: string) => rules.find((rule) => rule.prelude === selector)?.body;
const mobileRule = (selector: string) => {
  const declarations = mobileBlocks.map((block) => exactRule(directRules(block), selector)).find((rule) => rule !== undefined);
  expect(declarations, `${selector} directly inside max-width: 600px`).toBeDefined();
  return declarations!;
};
const baseRule = (selector: string) => {
  const declarations = exactRule(topLevelRules, selector);
  expect(declarations, `top-level ${selector}`).toBeDefined();
  return declarations!;
};

describe("narrow-screen touch targets", () => {
  it("keeps mobile ribbon controls compact while preserving 44px action targets", () => {
    expect(mobileRule(".nav-bar a, .nav-button")).toMatch(/(?:^|;)\s*min-height:\s*36px\s*(?:;|$)/);
    expect(mobileRule("button:not(.nav-button), .primary-action, .secondary-action")).toMatch(/(?:^|;)\s*min-height:\s*44px\s*(?:;|$)/);
  });

  it("uses smaller selected-pick text while keeping the Remove control touch-sized on mobile", () => {
    expect(baseRule(".tray-item-label")).toMatch(/(?:^|;)\s*font-size:\s*0\.85rem\s*(?:;|$)/);
    const remove = baseRule(".selection-tray-remove");
    expect(remove).toMatch(/(?:^|;)\s*background:\s*transparent\s*(?:;|$)/);
    expect(remove).toMatch(/(?:^|;)\s*text-decoration:\s*underline\s*(?:;|$)/);
    expect(mobileRule(".selection-tray-remove")).toMatch(/(?:^|;)\s*min-height:\s*44px\s*(?:;|$)/);
    expect(baseRule("button:not(.primary-action):not(.nav-button):not(.selection-tray-remove):hover:not(:disabled)"))
      .toMatch(/(?:^|;)\s*background:\s*#2f5f9e\s*(?:;|$)/);
  });

  it("keeps the mobile amount input beside a wrapping matchup", () => {
    const trayItems = mobileRule(".selection-tray-list li");
    expect(trayItems).toMatch(/(?:^|;)\s*display:\s*grid\s*(?:;|$)/);
    expect(trayItems).toMatch(/(?:^|;)\s*grid-template-columns:\s*minmax\(0, 1fr\) 4\.5rem auto\s*(?:;|$)/);
    expect(trayItems).toMatch(/(?:^|;)\s*grid-template-areas:\s*"selection risk remove"\s*(?:;|$)/);
    expect(mobileRule(".selection-tray-amount")).toMatch(/(?:^|;)\s*grid-area:\s*risk\s*(?:;|$)/);
    expect(trayItems).not.toContain('grid-template-areas: "selection remove" "risk remove";');
  });
});
