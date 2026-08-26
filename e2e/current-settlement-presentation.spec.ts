import { test, expect } from "./fixtures/local-worker";

async function signInOwner(page: import("@playwright/test").Page, baseURL: string, mailbox: () => Promise<Array<{ kind: "verification"; to: string; token: string }>>) {
  await page.context().clearCookies();
  await page.goto(`${baseURL}/sign-up`);
  await page.getByLabel("Name").fill("Settlement Owner");
  await page.getByLabel("Email address").fill("settlement-owner@example.test");
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect.poll(async () => (await mailbox()).find((message) => message.to === "settlement-owner@example.test")?.token).toBeTruthy();
  const token = (await mailbox()).find((message) => message.to === "settlement-owner@example.test")!.token;
  await page.evaluate(async (value) => { await fetch(`/api/auth/verify-email?token=${encodeURIComponent(value)}`); }, token);
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
  await page.getByRole("link", { name: "Season", exact: true }).click();
  await page.getByLabel("Season label").fill("2026");
  await page.getByRole("button", { name: "Create season" }).click();
  await page.getByRole("button", { name: "Open season" }).click();
  await page.getByRole("link", { name: "Pool overview" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await page.getByLabel("Amount").fill("3");
  await page.getByRole("button", { name: "Quote order" }).click();
  await page.getByRole("button", { name: "Confirm order" }).click();
}

test("My Wagers shows only the current settlement economics after real regrades and a settled void", async ({ page, browser, worker }) => {
  const slug = "current-settlement-pool";
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await createAndFundPool(page, worker.baseURL, slug);

  await page.getByRole("link", { name: "Odds", exact: true }).click();
  await page.getByRole("button", { name: "Select Local Away 3", exact: true }).click();
  await page.getByLabel("Risk in whole shares").fill("1");
  await page.getByRole("button", { name: "Review straight wager" }).click();
  await page.getByRole("button", { name: "Place wager" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${slug}/my-wagers$`));
  await expect(page.getByRole("heading", { name: "Active tickets" })).toBeVisible();
  await expect(page.getByText("Open", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /cancel/i })).toHaveCount(0);

  const wagerId = await page.evaluate(async (poolSlug) => {
    const body = await (await fetch(`/api/p/${poolSlug}/wagers`)).json() as { wagers: Array<{ wagerId: string }> };
    return body.wagers[0]!.wagerId;
  }, slug);
  const finalized = await page.evaluate(async () => (await fetch("/__local-test/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "local-nfl-upcoming", homeScore: 17, awayScore: 24 }) })).status);
  expect(finalized).toBe(200);
  const currentTime = new Date(Date.now() + 10 * 60_000).toISOString();
  const settled = await page.evaluate(async ({ poolSlug, currentTime }) => (await fetch("/__local-test/alarm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug, currentTime }) })).status, { poolSlug: slug, currentTime });
  expect(settled).toBe(200);
  expect(await page.evaluate(async ({ poolSlug, currentTime }) => (await fetch("/__local-test/current-time", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug, currentTime }) })).status, { poolSlug: slug, currentTime })).toBe(200);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Completed tickets" })).toBeVisible();
  await expect(page.getByText("won", { exact: true })).toBeVisible();
  await expect(page.getByText(/Outcome: win; return 2\.00 shares; profit 1\.00 shares\./)).toBeVisible();

  const regraded = await page.evaluate(async ({ poolSlug, id }) => (await fetch(`/api/p/${poolSlug}/admin/corrections/${id}/regrade`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), reason: "Official correction", correctedResults: [{ eventId: "local-nfl-upcoming", league: "nfl", status: "final", homeScore: 24, awayScore: 17, correctionVersion: "official-loss-v2" }] }) })).status, { poolSlug: slug, id: wagerId });
  expect(regraded).toBe(200);
  await page.reload();
  await expect(page.getByText("lost", { exact: true })).toBeVisible();
  await expect(page.getByText(/Outcome: loss; return 0\.00 shares; profit 0\.00 shares\./)).toBeVisible();
  await expect(page.getByText(/Outcome: win; return 2\.00 shares/)).toHaveCount(0);

  const voided = await page.evaluate(async ({ poolSlug, id }) => (await fetch(`/api/p/${poolSlug}/admin/corrections/${id}/void`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), reason: "Settled ticket void" }) })).status, { poolSlug: slug, id: wagerId });
  expect(voided).toBe(200);
  await page.reload();
  await expect(page.getByText("refunded", { exact: true })).toBeVisible();
  await expect(page.getByText(/Outcome: refund; return 1\.00 shares; profit 0\.00 shares\./)).toBeVisible();
  await expect(page.getByText(/Outcome: loss; return 0\.00 shares/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /cancel/i })).toHaveCount(0);

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await member.goto(`${worker.baseURL}/sign-up`);
    await member.getByLabel("Name").fill("Settlement Member");
    await member.getByLabel("Email address").fill("settlement-member@example.test");
    await member.getByLabel("Password").fill("first-password");
    await member.getByRole("button", { name: "Create account" }).click();
    await expect.poll(async () => (await worker.mailbox()).find((message) => message.to === "settlement-member@example.test")?.token).toBeTruthy();
    const token = (await worker.mailbox()).find((message) => message.to === "settlement-member@example.test")!.token;
    await member.evaluate(async (value) => { await fetch(`/api/auth/verify-email?token=${encodeURIComponent(value)}`); }, token);
    await member.getByRole("link", { name: "log in", exact: true }).click();
    await member.getByLabel("Email address").fill("settlement-member@example.test");
    await member.getByLabel("Password").fill("first-password");
    await member.getByRole("button", { name: "Log in" }).click();
    await member.goto(`${worker.baseURL}/p/${slug}`);
    await member.getByLabel("Pool password").fill("settlement-password");
    await member.getByRole("button", { name: "Join pool" }).click();
    await member.goto(`${worker.baseURL}/p/${slug}/my-wagers`);
    await expect(member.getByRole("heading", { name: "Active tickets" })).toBeVisible();
    await expect(member.getByRole("heading", { name: "Completed tickets" })).toBeVisible();
    await expect(member.getByText("No active tickets.")).toBeVisible();
    await expect(member.getByText("No completed tickets.")).toBeVisible();
    await expect(member.getByRole("button", { name: /cancel/i })).toHaveCount(0);
  } finally {
    await memberContext.close();
  }
});
