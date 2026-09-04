import { test, expect } from "./fixtures/local-worker";

async function signInOwner(page: import("@playwright/test").Page, baseURL: string, mailbox: () => Promise<Array<{ kind: "verification"; to: string; token: string }>>) {
  await page.context().clearCookies();
  await page.goto(`${baseURL}/sign-up`);
  await page.getByLabel("Name").fill("Settlement Owner");
  await page.getByLabel("Email address").fill("settlement-owner@example.test");
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("link", { name: "log in", exact: true }).click();
  await page.getByLabel("Email address").fill("settlement-owner@example.test");
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Log in" }).click();
}

async function createAndFundPool(page: import("@playwright/test").Page, baseURL: string, slug: string) {
  await page.goto(`${baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Current Settlement Pool");
  await page.getByLabel("Pool web address").fill(slug);
  await page.getByLabel("Join password").fill("settlement-password");
  await page.getByRole("button", { name: "Create pool" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Season", exact: true }).click();
  await page.getByLabel("Season label").fill("2026");
  await page.getByRole("button", { name: "Create season" }).click();
  await page.getByRole("button", { name: "Open season" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await page.getByLabel("Amount").fill("3");
  await page.getByRole("button", { name: "Quote order" }).click();
  await page.getByRole("button", { name: "Confirm order" }).click();
}

test("My Wagers shows only the current settlement economics after real regrades and a settled void", async ({ page, browser, worker }) => {
  const slug = "current-settlement-pool";
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await createAndFundPool(page, worker.baseURL, slug);

  await page.getByRole("link", { name: "Odds board", exact: true }).click();
  await page.getByRole("checkbox", { name: "Local Away +3", exact: true }).check();
  await page.getByLabel(/^Risk in whole shares for .*: spread/).fill("1");
  await page.getByRole("button", { name: "Place bets" }).click();
  await page.getByRole("button", { name: "Place 1 wager" }).click();
  await page.getByRole("link", { name: "My wagers" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${slug}/my-wagers$`));
  await expect(page.getByRole("heading", { name: "Open bets" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Open bets" })).toBeVisible();
  await expect(page.getByRole("button", { name: /cancel/i })).toHaveCount(0);

  const wagerId = await page.evaluate(async (poolSlug) => {
    const body = await (await fetch(`/api/p/${poolSlug}/wagers`)).json() as { wagers: Array<{ wagerId: string }> };
    return body.wagers[0]!.wagerId;
  }, slug);
  const finalized = await page.evaluate(async () => (await fetch("/__local-test/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "local-nfl-upcoming", homeScore: 17, awayScore: 24 }) })).status);
  expect(finalized).toBe(200);
  // Local placement fixtures intentionally start just over 24 hours after reseeding.
  const currentTime = new Date(Date.now() + 26 * 60 * 60_000).toISOString();
  const settled = await page.evaluate(async ({ poolSlug, currentTime }) => (await fetch("/__local-test/alarm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug, currentTime }) })).status, { poolSlug: slug, currentTime });
  expect(settled).toBe(200);
  expect(await page.evaluate(async ({ poolSlug, currentTime }) => (await fetch("/__local-test/current-time", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug, currentTime }) })).status, { poolSlug: slug, currentTime })).toBe(200);

  await page.reload();
  const settledBets = page.getByRole("table", { name: "Settled bets" });
  await expect(page.getByRole("heading", { name: "Settled bets" })).toBeVisible();
  await expect(settledBets.locator("tbody tr").first().locator("td").first()).toHaveText(/^\d{2}\/\d{2} \d{2}:\d{2}[ap]$/);
  await expect(settledBets.locator("tbody tr").first().locator("td").last()).toHaveText("+1.00 shares");
  await expect(settledBets.locator("tbody tr").first().locator("td").last()).toHaveClass("activity-performance-won");
  await expect(settledBets.locator("tbody tr").first()).toContainText("2.00");

  const regraded = await page.evaluate(async ({ poolSlug, id }) => (await fetch(`/api/p/${poolSlug}/admin/corrections/${id}/regrade`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), reason: "Official correction", correctedResults: [{ eventId: "local-nfl-upcoming", league: "nfl", status: "final", homeScore: 24, awayScore: 17, correctionVersion: "official-loss-v2" }] }) })).status, { poolSlug: slug, id: wagerId });
  expect(regraded).toBe(200);
  await page.reload();
  await expect(settledBets.locator("tbody tr").first().locator("td").last()).toHaveText("-1.00 shares");
  await expect(settledBets.locator("tbody tr").first().locator("td").last()).toHaveClass("activity-performance-lost");
  await expect(settledBets.locator("tbody tr").first()).toContainText("0.00");

  const voided = await page.evaluate(async ({ poolSlug, id }) => (await fetch(`/api/p/${poolSlug}/admin/corrections/${id}/void`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), reason: "Settled ticket void" }) })).status, { poolSlug: slug, id: wagerId });
  expect(voided).toBe(200);
  await page.reload();
  await expect(settledBets.locator("tbody tr").first().locator("td").last()).toHaveText("0.00 shares");
  await expect(settledBets.locator("tbody tr").first().locator("td").last()).not.toHaveClass(/activity-performance-(won|lost)/);
  await expect(settledBets.locator("tbody tr").first()).toContainText("1.00");
  await expect(page.getByRole("button", { name: /cancel/i })).toHaveCount(0);

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await member.goto(`${worker.baseURL}/sign-up`);
    await member.getByLabel("Name").fill("Settlement Member");
    await member.getByLabel("Email address").fill("settlement-member@example.test");
    await member.getByLabel("Password").fill("first-password");
    await member.getByRole("button", { name: "Create account" }).click();
    await member.getByRole("link", { name: "log in", exact: true }).click();
    await member.getByLabel("Email address").fill("settlement-member@example.test");
    await member.getByLabel("Password").fill("first-password");
    await member.getByRole("button", { name: "Log in" }).click();
    await member.goto(`${worker.baseURL}/p/${slug}`);
    await member.getByLabel("Pool password").fill("settlement-password");
    await member.getByRole("button", { name: "Join pool" }).click();
    await member.goto(`${worker.baseURL}/p/${slug}/my-wagers`);
    await expect(member.getByRole("heading", { name: "Open bets" })).toBeVisible();
    await expect(member.getByRole("heading", { name: "Settled bets" })).toBeVisible();
    await expect(member.getByText("No open bets.")).toBeVisible();
    await expect(member.getByText("No settled bets.")).toBeVisible();
    await expect(member.getByRole("button", { name: /cancel/i })).toHaveCount(0);
  } finally {
    await memberContext.close();
  }
});
