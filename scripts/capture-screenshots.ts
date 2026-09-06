import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { runLocalWorkerOwner } from "../e2e/fixtures/local-worker";
import { createActivePool } from "../e2e/fixtures/local-pool";
import { screenshotRoutes, screenshotViewports } from "./screenshot-plan.mjs";

const phase = process.argv.find((argument) => argument.startsWith("--phase="))?.split("=")[1];
if (phase !== "initial" && phase !== "final") throw new Error("Use --phase=initial or --phase=final.");
if (!existsSync("dist/client/index.html")) throw new Error("Build browser assets before capturing finish screenshots.");

await mkdir("artifacts/screenshots", { recursive: true });

await runLocalWorkerOwner(async (worker) => {
  const browser = await chromium.launch();
  try {
    const setup = await browser.newPage();
    const pool = await createActivePool(setup, worker, { slug: "finish-review", name: "Finish Review Pool" });
    const routes = screenshotRoutes(pool.slug, pool.seasonId, pool.name, pool.seasonLabel);
    const activeRoutes = routes.filter((route) => route.name !== "history");
    const history = routes.find((route) => route.name === "history");
    for (const viewport of screenshotViewports) {
      const page = await browser.newPage({ viewport });
      await page.context().addCookies(await setup.context().cookies());
      for (const route of activeRoutes) {
        await page.goto(`${worker.baseURL}${route.path}`, { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: route.heading, exact: true }).waitFor();
        if (route.name === "odds") await page.locator(".pool-balance").waitFor();
        await page.screenshot({ path: `artifacts/screenshots/${phase}-${route.name}-${viewport.name}.png`, fullPage: true });
      }
      await page.close();
    }
    if (!history) throw new Error("Finish screenshot plan is missing history.");
    const response = await setup.evaluate(async (slug) => { const result = await fetch("/__local-test/season", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug: slug, state: "closed" }) }); return { ok: result.ok, status: result.status }; }, pool.slug);
    if (!response.ok) throw new Error(`Could not close local finish-review season: ${response.status}`);
    for (const viewport of screenshotViewports) {
      const page = await browser.newPage({ viewport });
      await page.context().addCookies(await setup.context().cookies());
      await page.goto(`${worker.baseURL}${history.path}`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: history.heading, exact: true }).waitFor();
      await page.screenshot({ path: `artifacts/screenshots/${phase}-${history.name}-${viewport.name}.png`, fullPage: true });
      await page.close();
    }
    await setup.close();
  } finally {
    await browser.close();
  }
});
