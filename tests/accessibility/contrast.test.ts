import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../../src/web/styles.css"), "utf8");
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
const luminance = (hex: string) => {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color token: ${hex}`);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrast = (first: string, second: string) => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

describe("WCAG AA interface colors", () => {
  it("keeps primary text, navigation, buttons, links, and errors at AA contrast", () => {
    const colors = Object.fromEntries(["navy", "blue", "paper", "ink", "orange", "notice-background", "notice-ink"].map((name) => [name, token(name)]));
    expect(Object.values(colors)).not.toContain(undefined);
    expect(contrast(colors.ink!, colors.paper!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", colors.navy!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", colors.blue!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", colors.orange!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#003f7d", colors.paper!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#551010", "#fff2f2")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors["notice-ink"]!, colors["notice-background"]!)).toBeGreaterThanOrEqual(4.5);
  });
});
