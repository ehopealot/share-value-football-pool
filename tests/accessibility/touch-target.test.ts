import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../../src/web/styles.css"), "utf8");

describe("narrow-screen touch targets", () => {
  it("gives ribbon and action controls a 44px minimum target at the mobile breakpoint", () => {
    expect(css).toMatch(/@media \(max-width: 600px\)[^{]*\{[\s\S]*\.nav-bar a, \.nav-button, button, \.primary-action, \.secondary-action\s*\{[\s\S]*min-height:\s*44px/);
  });
});
