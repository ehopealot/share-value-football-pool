import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(resolve(import.meta.dirname, `../../src/web/${file}`), "utf8");

describe("wide table reflow", () => {
  it("places member, activity, order, and teaser tables in focusable horizontal regions", () => {
    for (const file of ["pages/MyWagersPage.tsx", "pages/ActivityPage.tsx", "pages/AdminOrdersPage.tsx", "pages/TeaserPage.tsx"]) {
      expect(source(file), file).toContain('className="table-scroll" tabIndex={0}');
    }
  });
});
