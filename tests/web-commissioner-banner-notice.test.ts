import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommissionerNotice } from "../src/web/components/Layout";

const root = resolve(import.meta.dirname, "..");
const layout = () => readFileSync(resolve(root, "src/web/components/Layout.tsx"), "utf8");
const settings = () => readFileSync(resolve(root, "src/web/pages/AdminSettingsPage.tsx"), "utf8");
const css = () => readFileSync(resolve(root, "src/web/styles.css"), "utf8");

describe("commissioner banner notice", () => {
  it("renders a labelled, non-live semantic banner", () => {
    const markup = renderToStaticMarkup(createElement(CommissionerNotice, { notice: "Draft starts\nat noon." }));

    expect(markup).toContain("<aside");
    expect(markup).toContain('aria-label="Commissioner notice"');
    expect(markup).toContain("Commissioner notice");
    expect(markup).toContain("Draft starts\nat noon.");
    expect(markup).not.toContain("aria-live");
    expect(markup).not.toContain('role="alert"');
  });

  it("places an authorized notice after the masthead and before primary navigation", () => {
    const source = layout();
    const masthead = source.indexOf('<header className="masthead">');
    const notice = source.indexOf("<CommissionerNotice notice={view.pool.commissionerNotice}");
    const navigation = source.indexOf('<nav aria-label="Primary navigation"');

    expect(masthead).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(masthead);
    expect(navigation).toBeGreaterThan(notice);
    expect(source).toContain("view.pool.commissionerNotice !== null");
  });

  it("keeps notice content readable on narrow screens and exposes bounded commissioner controls", () => {
    expect(css()).toMatch(/\.commissioner-notice\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*pre-wrap/s);
    expect(css()).toContain("--notice-background");
    expect(css()).toContain("--notice-ink");
    expect(settings()).toContain('htmlFor="commissioner-notice"');
    expect(settings()).toContain('id="commissioner-notice"');
    expect(settings()).toContain("maxLength={500}");
    expect(settings()).toContain("Save notice");
    expect(settings()).toContain("Clear notice");
    expect(settings()).toContain("invalidatePoolView()");
  });

  it("groups settings actions with their controls and explains the notice banner", () => {
    expect(settings()).toContain('className="pool-settings"');
    expect(settings()).toContain('className="share-order-form pool-settings-notice-controls"');
    expect(settings()).toContain('id="commissioner-notice-help"');
    expect(settings()).toContain('aria-describedby="commissioner-notice-help"');
    expect(settings()).toContain("This notice displays in a banner on joined pool pages.");
    expect(css()).toMatch(/\.pool-settings\s*\{[^}]*display:\s*grid[^}]*gap:/s);
    expect(css()).toMatch(/\.pool-settings-notice-field\s*\{[^}]*flex:\s*1 1 min\(100%, 65ch\)/s);
  });
});
