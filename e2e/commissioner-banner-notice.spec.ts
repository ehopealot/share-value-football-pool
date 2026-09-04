import { test, expect } from "./fixtures/local-worker";
import { createActivePool, signIn } from "./fixtures/local-pool";

test("commissioners can set and clear a member-only notice banner across pool routes", async ({ page, browser, worker }) => {
  const pool = await createActivePool(page, worker, { slug: "commissioner-notice", name: "Commissioner Notice" });
  const firstNotice = "Draft starts at noon.";
  const replacementNotice = "Lineup lock moved to Friday.\nCheck the rules.";
  const banner = page.getByRole("complementary", { name: "Commissioner notice" });

  await page.goto(`${worker.baseURL}/p/${pool.slug}/admin/settings`);
  await expect(page.getByRole("heading", { name: "Pool settings" })).toBeVisible();
  await page.getByRole("textbox", { name: "Commissioner notice" }).fill(firstNotice);
  const firstSave = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/p/${pool.slug}/admin/settings`));
  await page.getByRole("button", { name: "Save notice" }).click();
  expect((await firstSave).status()).toBe(200);
  await expect(banner).toContainText(firstNotice.toUpperCase());

  await page.getByRole("textbox", { name: "Commissioner notice" }).fill(replacementNotice);
  const replacementSave = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/p/${pool.slug}/admin/settings`));
  await page.getByRole("button", { name: "Save notice" }).click();
  expect((await replacementSave).status()).toBe(200);
  await expect(banner).toContainText(replacementNotice.toUpperCase());
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => page.getByRole("link", { name: "Odds board", exact: true }).evaluate((link) => link.getBoundingClientRect().height >= 44)).toBe(true);

  for (const [link, heading] of [["Odds board", "Odds board"], ["Standings", "Standings"], ["Message board", "Message board"], ["Pool home", "Commissioner Notice"]] as const) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(banner).toContainText(replacementNotice.toUpperCase());
  }

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  try {
    await signIn(member, worker, { name: "Notice Member", email: "notice-member@example.test" });
    await member.goto(`${worker.baseURL}/p/${pool.slug}`);
    await member.getByLabel("Pool password").fill("local-pool-password");
    await member.getByRole("button", { name: "Join pool" }).click();
    await expect(member).toHaveURL(new RegExp(`/p/${pool.slug}/odds$`));
    await expect(member.getByRole("complementary", { name: "Commissioner notice" })).toContainText(replacementNotice.toUpperCase());
    await member.goto(`${worker.baseURL}/p/${pool.slug}/admin/settings`);
    await expect(member.getByRole("alert")).toHaveText("Only the commissioner can change pool settings.");
    await expect(member.getByRole("textbox", { name: "Commissioner notice" })).toHaveCount(0);
    const forgedStatus = await member.evaluate(async (slug) => {
      const response = await fetch(`/api/p/${slug}/admin/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commissionerNotice: "Forged notice", idempotencyKey: crypto.randomUUID() })
      });
      return response.status;
    }, pool.slug);
    expect(forgedStatus).toBe(403);

    await signIn(visitor, worker, { name: "Notice Visitor", email: "notice-visitor@example.test" });
    await visitor.goto(`${worker.baseURL}/p/${pool.slug}`);
    await expect(visitor.getByRole("heading", { name: "Join Commissioner Notice" })).toBeVisible();
    await expect(visitor.getByText(replacementNotice, { exact: true })).toHaveCount(0);

    await page.goto(`${worker.baseURL}/p/${pool.slug}/admin/settings`);
    const clear = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/p/${pool.slug}/admin/settings`));
    await page.getByRole("button", { name: "Clear notice" }).click();
    expect((await clear).status()).toBe(200);
    await expect(banner).toHaveCount(0);

    await member.goto(`${worker.baseURL}/p/${pool.slug}/standings`);
    await expect(member.getByRole("heading", { name: "Standings" })).toBeVisible();
    await expect(member.getByRole("complementary", { name: "Commissioner notice" })).toHaveCount(0);
  } finally {
    await memberContext.close();
    await visitorContext.close();
  }
});
