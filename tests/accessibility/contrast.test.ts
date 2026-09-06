import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../../src/web/styles.css"), "utf8");
const declarations = (selector: string) => {
  const match = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((candidate) => candidate[1].replace(/\/\*[\s\S]*?\*\//g, "").trim() === selector);
  expect(match, `CSS rule ${selector}`).toBeDefined();
  return match![2];
};
const property = (selector: string, name: string) => {
  const value = declarations(selector).match(new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`))?.[1]?.trim();
  expect(value, `${name} in ${selector}`).toBeDefined();
  return value!;
};
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})`))?.[1];
const resolveColor = (value: string) => {
  const variable = value.match(/^var\(--([\w-]+)\)$/)?.[1];
  const color = variable ? token(variable) : value;
  if (!color) throw new Error(`Undefined color: ${value}`);
  return color.length === 4 ? `#${[...color.slice(1)].map((channel) => channel.repeat(2)).join("")}` : color;
};
const luminance = (hex: string) => {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color token: ${hex}`);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrast = (first: string, second: string) => {
  const [lighter, darker] = [luminance(resolveColor(first)), luminance(resolveColor(second))].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

const expectRuleContrast = (foregroundSelector: string, backgroundSelector = foregroundSelector) => {
  expect(contrast(property(foregroundSelector, "color"), property(backgroundSelector, "background"))).toBeGreaterThanOrEqual(4.5);
};

describe("WCAG AA interface colors", () => {
  it("keeps primary text, navigation, buttons, links, and errors at AA contrast", () => {
    expectRuleContrast("body");
    expectRuleContrast(".masthead");
    expectRuleContrast(".nav-bar a", ".nav-bar");
    expectRuleContrast(".nav-button", ".nav-bar");
    expectRuleContrast("button");
    expectRuleContrast("button", "button:not(.primary-action):not(.nav-button):not(.selection-tray-remove):hover:not(:disabled)");
    expectRuleContrast(".primary-action");
    expectRuleContrast(".secondary-action");
    expectRuleContrast("a", ".site-shell");
    expectRuleContrast(".error-summary");
    expectRuleContrast(".commissioner-notice");
  });
});
