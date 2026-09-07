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
    expect(markup).toContain("DRAFT STARTS\nAT NOON.");
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
    expect(settings()).toContain('aria-labelledby="commissioner-notice-settings-heading"');
    expect(settings()).toContain('id="commissioner-notice"');
    expect(settings()).not.toContain(">Notice text<");
    expect(settings()).toContain("maxLength={500}");
    expect(settings()).toContain('setCommissionerNotice((value.pool.commissionerNotice ?? "").toUpperCase())');
    expect(settings()).toContain("setCommissionerNotice(e.target.value.toUpperCase().slice(0, 500))");
    expect(settings()).toContain("Save notice");
    expect(settings()).toContain("Clear notice");
    expect(settings()).toContain("invalidatePoolView()");
  });

  it("groups settings actions with their controls and explains the notice banner", () => {
    expect(settings()).toContain('className="pool-settings"');
    expect(settings()).toContain('className="share-order-form pool-settings-notice-controls"');
    expect(settings()).toContain('id="commissioner-notice-help"');
    expect(settings()).toContain('aria-describedby="commissioner-notice-help"');
    expect(settings()).toContain("This notice displays in a banner above this pool.");
    expect(settings()).toContain("Password changes require a recent sign-in.");
    expect(settings()).not.toContain("Password rotation requires recent authentication.");
    expect(settings()).not.toContain("Teaser risk is split evenly across its sides for this limit.");
  });

  it("exposes bounded commissioner rules controls that publish only when filled in", () => {
    expect(settings()).toContain('aria-labelledby="commissioner-rules-settings-heading"');
    expect(settings()).toContain('id="commissioner-rules"');
    expect(settings()).toContain('id="commissioner-rules-help"');
    expect(settings()).toContain("These appear on the Rules page when filled in.");
    expect(settings()).toContain("maxLength={4000}");
    expect(settings()).toContain('setCommissionerRules(value.pool.commissionerRules ?? "")');
    expect(settings()).toContain("Save rules");
    expect(settings()).toContain("Clear rules");
    expect(settings()).toContain('view.pool.commissionerRules !== null');
    expect(css()).toContain('.commissioner-rules-input { display: block; width: min(100%, 65ch); min-height: 10rem;');
    expect(css()).toMatch(/\.commissioner-rules-text\s*\{[^}]*white-space:\s*pre-wrap/s);
  });

  it("rehydrates only the saved section so unrelated settings drafts survive a save", () => {
    expect(settings()).toContain('const load = (sections: readonly SettingsSection[] = allSettingsSections)');
    expect(settings()).toContain('for (const section of sections) hydrate[section](value);');
    expect(settings()).toContain('const save = async (identity: string, createBody: () => Record<string, unknown>, sections: readonly SettingsSection[] = []) => {');
    expect(settings()).toContain('save(`notice:${commissionerNotice}`, () => ({ commissionerNotice }), ["notice"])');
    expect(settings()).toContain('save(`rules:${commissionerRules}`, () => ({ commissionerRules }), ["rules"])');
    expect(settings()).toContain('save("clear-rules", () => ({ commissionerRules: null }), ["rules"])');
    expect(settings()).toContain('save("rename", () => ({ poolName: name }), ["name"])');
    // Password rotation and signup toggles own no long-lived draft, so they only refresh the view.
    expect(settings()).toContain('save("rotate-password", () => ({ password }))');
    expect(settings()).toContain('save(`signups:${nextSignups}`, () => ({ signupsOpen: nextSignups }))');
  });

  it("lays out settings sections and their notice fields", () => {
    expect(css()).toMatch(/\.pool-settings\s*\{[^}]*display:\s*grid[^}]*gap:/s);
    expect(css()).toMatch(/\.pool-settings-notice-field\s*\{[^}]*flex:\s*1 1 min\(100%, 65ch\)/s);
  });

  it("uses each settings section title instead of repeating field labels", () => {
    const source = settings();

    expect(source).toContain('<h2 id="join-password-settings-heading">Change join password</h2>');
    expect(source).toContain('aria-labelledby="pool-name-settings-heading"');
    expect(source).toContain('aria-labelledby="join-password-settings-heading"');
    expect(source).toContain('aria-labelledby="max-bet-settings-heading"');
    expect(source).not.toContain("<label>Pool name");
    expect(source).not.toContain("<label>New join password");
    expect(source).not.toContain("<label>Max bet per side");
    expect(css()).toMatch(/\.pool-settings-control\s*\{[^}]*flex:\s*1 1 16rem/s);
  });
});
