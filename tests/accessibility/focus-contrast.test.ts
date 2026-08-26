import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../../src/web/styles.css"), "utf8");

function luminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex color, received ${hex}.`);
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("focus indicator", () => {
  it("has at least 3:1 contrast on paper and dark navigation surfaces", () => {
    const focus = css.match(/--focus:\s*(#[0-9a-fA-F]{6})/)?.[1];
    const focusOnDark = css.match(/--focus-on-dark:\s*(#[0-9a-fA-F]{6})/)?.[1];
    const paper = css.match(/--paper:\s*(#[0-9a-fA-F]{6})/)?.[1];
    const blue = css.match(/--blue:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(focus).toBeDefined();
    expect(focusOnDark).toBeDefined();
    expect(paper).toBeDefined();
    expect(blue).toBeDefined();
    expect(contrast(focus!, paper!)).toBeGreaterThanOrEqual(3);
    expect(contrast(focusOnDark!, blue!)).toBeGreaterThanOrEqual(3);
  });

  it("uses the dark-surface focus token for the signed-in logout button", () => {
    expect(css).toMatch(/\.nav-button:focus-visible\s*\{[^}]*outline-color:\s*var\(--focus-on-dark\)/);
  });
});
