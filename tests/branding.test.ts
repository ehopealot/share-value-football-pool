import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Layout } from "../src/web/components/Layout";

const root = resolve(import.meta.dirname, "..");

describe("Office Pool Reborn branding", () => {
  it("uses the product name in the browser shell and deployment identity", () => {
    const rendered = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Layout, null, "content")));
    const html = readFileSync(resolve(root, "index.html"), "utf8");
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { name: string };
    const wrangler = JSON.parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8")) as { name: string };

    expect(rendered).toContain("Office Pool Reborn");
    expect(html).toContain("<title>Office Pool Reborn</title>");
    expect(manifest.name).toBe("office-pool-reborn");
    expect(wrangler.name).toBe("office-pool-reborn");
  });
});
