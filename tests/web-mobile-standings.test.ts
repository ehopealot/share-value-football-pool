import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StandingsTable } from "../src/web/pages/StandingsPage";

const css = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");

describe("compact mobile standings", () => {
  it("scopes roomier-than-activity compact sizing to mobile standings", () => {
    expect(css).toContain("@media (max-width: 600px) { .standings-page table { font-size: 0.875rem; } .standings-page th, .standings-page td { padding: 0.35rem; } }");
  });

  it("underlines the active sort header without a visible direction indicator", () => {
    const html = renderToStaticMarkup(createElement(StandingsTable, { standings: [] }));
    expect(html).not.toMatch(/▲|▼|standings-sort-indicator/);
    expect(html.match(/aria-sort="ascending"/g)).toHaveLength(1);
    expect(html.match(/aria-sort="none"/g)).toHaveLength(6);
    expect(html).toContain('>Rank</button>');
    expect(css).toContain('th[aria-sort="ascending"] > button.standings-sort, th[aria-sort="descending"] > button.standings-sort { text-decoration: underline; }');
    expect(css).not.toContain("th > button.standings-sort:hover { text-decoration: underline; }");
    expect(css).not.toContain(".standings-sort-indicator");
  });
});
