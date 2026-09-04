import { test, expect } from "./fixtures/local-worker";

const board = () => {
  const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const offers = Array.from({ length: 80 }, (_, index) => {
    const eventId = `perf-event-${index}`, awayTeam = `Away ${index}`, homeTeam = `Home ${index}`;
    const base = { eventId, league: "nfl", awayTeam, homeTeam, startsAt, canonicalBook: "DraftKings", retrievedAt: startsAt, offerVersion: "perf-v1", policyVersion: "CANONICAL_BOOKS_2026_V1" };
    return [
      { ...base, market: "spread", outcomes: [{ name: awayTeam, price: -110, point: 3.5 }, { name: homeTeam, price: -110, point: -3.5 }] },
      { ...base, market: "total", outcomes: [{ name: "Over", price: -110, point: 45.5 }, { name: "Under", price: -110, point: 45.5 }] },
      { ...base, market: "moneyline", outcomes: [{ name: awayTeam, price: 120 }, { name: homeTeam, price: -140 }] }
    ];
  }).flat();
  return { offers, feed: { status: "current", message: "Odds are up to date.", lastPolledAt: startsAt, lastSuccessAt: startsAt } };
};

async function createPool(page: import("@playwright/test").Page, baseURL: string, slug: string) {
  await page.goto(`${baseURL}/sign-up`);
  await page.getByLabel("Name").fill("Perf Owner");
  await page.getByLabel("Email address").fill(`${slug}@example.test`);
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("link", { name: "log in", exact: true }).click();
  await page.getByLabel("Email address").fill(`${slug}@example.test`);
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.goto(`${baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Perf Pool");
  await page.getByLabel("Pool web address").fill(slug);
  await page.getByLabel("Join password").fill("orders-password");
  await page.getByRole("button", { name: "Create pool" }).click();
}

test("typing a risk stays responsive on an 80-game odds board", async ({ page, worker }) => {
  const slug = `perf-${crypto.randomUUID()}`;
  await page.route("**/api/p/*/odds*", async (route) => new URL(route.request().url()).pathname === `/api/p/${slug}/odds` ? route.fulfill({ contentType: "application/json", body: JSON.stringify(board()) }) : route.continue());
  await createPool(page, worker.baseURL, slug);
  await expect(page.getByRole("heading", { name: "Odds board" })).toBeVisible();
  await page.getByRole("checkbox").first().check();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label^="Risk in whole shares for "]');
    if (!input) throw new Error("risk input missing");
    (window as Window & { delays?: number[] }).delays = [];
    input.addEventListener("input", () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => (window as Window & { delays: number[] }).delays.push(performance.now() - start))); });
  });
  await page.getByLabel(/^Risk in whole shares for /).first().pressSequentially("1234567890");
  await expect.poll(() => page.evaluate(() => (window as Window & { delays?: number[] }).delays?.length ?? 0)).toBe(10);
  const delays = await page.evaluate(() => (window as Window & { delays: number[] }).delays);
  expect(Math.max(...delays)).toBeLessThan(200);
});

test("filters odds board teams locally with fuzzy matching", async ({ page, worker }) => {
  const slug = `team-filter-${crypto.randomUUID()}`;
  let oddsRequests = 0;
  await page.route("**/api/p/*/odds*", async (route) => {
    if (new URL(route.request().url()).pathname !== `/api/p/${slug}/odds`) return route.continue();
    oddsRequests++;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(board()) });
  });
  await createPool(page, worker.baseURL, slug);
  await expect(page.getByRole("heading", { name: "Odds board" })).toBeVisible();
  await expect(page.locator("tr.odds-game-top")).toHaveCount(80);
  const filter = page.getByLabel("Filter teams");
  await expect(filter).toBeVisible();
  const loadedRequests = oddsRequests;

  await filter.fill("Awy 12");
  await expect(page.locator("tr.odds-game-top")).toHaveCount(1);
  await expect(page.getByRole("rowheader", { name: /Away 12/ })).toBeVisible();
  expect(oddsRequests).toBe(loadedRequests);

  await filter.fill("zzzz");
  await expect(page.getByText("No teams match this filter.")).toBeVisible();
  await filter.fill("");
  await expect(page.locator("tr.odds-game-top")).toHaveCount(80);
  expect(oddsRequests).toBe(loadedRequests);
});
