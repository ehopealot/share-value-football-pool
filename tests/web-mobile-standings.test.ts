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

  it("reserves the same indicator space in every sortable header", () => {
    const html = renderToStaticMarkup(createElement(StandingsTable, { standings: [] }));
    expect(html.match(/class="standings-sort-indicator" aria-hidden="true"/g)).toHaveLength(7);
    expect(html).toContain('<span class="standings-sort-indicator" aria-hidden="true">▲</span>');
    expect(html.match(/class="standings-sort-indicator" aria-hidden="true"><\/span>/g)).toHaveLength(6);
    expect(html).toContain('aria-sort="ascending"');
    expect(css).toContain(".standings-sort-indicator { display: inline-block; width: 1em; margin-left: 0.25em; text-align: center; }");
  });
});
