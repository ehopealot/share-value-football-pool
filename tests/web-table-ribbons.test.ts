import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(resolve(import.meta.dirname, `../src/web/pages/${file}`), "utf8");

const odds = source("OddsPage.tsx");
const standings = source("StandingsPage.tsx");
const rules = source("RulesPage.tsx");
const overview = source("OverviewPage.tsx");
const orders = source("AdminOrdersPage.tsx");
const members = source("AdminMembersPage.tsx");
const corrections = source("AdminCorrectionsPage.tsx");
const home = source("HomePage.tsx");
const styles = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");

describe("table ribbons", () => {
  it("uses the shared blue ribbon immediately above each requested table", () => {
    expect(styles).toContain('.table-ribbon, .activity-member-ribbon { margin: 0; padding: var(--space-1) var(--space-2); background: var(--navy); color: #fff; font-size: 1rem; }');
    expect(odds).toContain('className="table-ribbon">Current odds</h2>');
    expect(standings).toContain('className="table-ribbon">Active season holdings</h2>');
    expect(rules).toContain('className="table-ribbon" id="season-rules-heading">Applicable season</h2>');
    expect(rules).toContain('className="table-ribbon" id="teaser-rules-heading">Teaser payouts: {selectedRuleset}</h2>');
    expect(rules).toContain('className="table-ribbon">Feed status</h3>');
    expect(overview).toContain('className="table-ribbon">Current account</h2>');
    expect(orders).toContain('className="table-ribbon">Order history</h2>');
    expect(members).toContain('className="table-ribbon">Active and suspended members</h2>');
    expect(corrections).toContain('className="table-ribbon">Eligible active-season wagers</h2>');
    expect(corrections).toContain('className="table-ribbon">Settlements and reversals</h3>');
    expect(home).toContain('className="table-ribbon">Your active memberships</h2>');
  });

  it("does not retain duplicate captions for ribbon-titled tables", () => {
    expect(odds).not.toContain("<caption>Current odds</caption>");
    expect(standings).not.toContain("<caption>Active season holdings</caption>");
    expect(rules).not.toContain("<caption>Fixed system teaser prices (American odds)</caption>");
    expect(overview).not.toContain("<caption>Current account</caption>");
    expect(members).not.toContain("<caption>Active and suspended members</caption>");
    expect(corrections).not.toContain("<caption>Eligible active-season wagers</caption>");
    expect(home).not.toContain("<caption>Your active memberships</caption>");
  });
});
