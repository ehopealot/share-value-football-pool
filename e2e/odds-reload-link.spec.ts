import { test, expect } from "./fixtures/local-worker";
import { createActivePool } from "./fixtures/local-pool";

const setFeedState = (page: import("@playwright/test").Page, state: "current" | "stale", observation: { lastPolledAt: string; lastSuccessAt: string; retrievedAt: string }) => page.evaluate(async ({ state, observation }) => {
  const response = await fetch("/__local-test/feed-state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, ...observation }) });
  return response.status;
}, { state, observation });

test("a stale odds feed offers a full-page Reload odds link", async ({ page, worker }) => {
  const pool = await createActivePool(page, worker, { slug: "stale-odds-reload", name: "Stale Odds Reload" });
  const now = new Date().toISOString();
  const observation = { lastPolledAt: now, lastSuccessAt: now, retrievedAt: now };
  expect(await setFeedState(page, "current", observation)).toBe(200);
  await page.goto(`${worker.baseURL}/p/${pool.slug}/odds`);
  await expect(page.getByRole("status")).toContainText("Board status: current");
  await expect(page.getByRole("link", { name: "Reload odds" })).toHaveCount(0);

  expect(await setFeedState(page, "stale", observation)).toBe(200);
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Board status: stale");
  const reload = page.getByRole("link", { name: "Reload odds" });
  await expect(reload).toHaveAttribute("href", `${worker.baseURL}/p/${pool.slug}/odds`);

  await page.evaluate(() => { (window as Window & { reloadMarker?: string }).reloadMarker = "before"; });
  expect(await setFeedState(page, "current", observation)).toBe(200);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), reload.click()]);
  await expect(page.getByRole("status")).toContainText("Board status: current");
  await expect(page.getByRole("link", { name: "Reload odds" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { reloadMarker?: string }).reloadMarker ?? null)).toBeNull();
});
