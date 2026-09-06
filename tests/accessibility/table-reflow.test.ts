import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(resolve(import.meta.dirname, `../../src/web/${file}`), "utf8");
const css = source("styles.css");
const tableScrollDeclarations = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .find((rule) => rule[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim() === ".table-scroll")?.[2];

describe("wide table reflow", () => {
  it("places member, activity, order, and teaser tables in focusable horizontally scrollable regions", () => {
    expect(tableScrollDeclarations, "exact .table-scroll CSS rule").toBeDefined();
    expect(tableScrollDeclarations).toMatch(/(?:^|;)\s*overflow-x:\s*auto\s*(?:;|$)/);
    for (const file of ["pages/MyWagersPage.tsx", "pages/ActivityPage.tsx", "pages/AdminOrdersPage.tsx", "pages/TeaserPage.tsx"]) {
      expect(source(file), file).toContain('className="table-scroll" tabIndex={0}');
    }
  });
});
