import { test, expect } from "./fixtures/local-worker";

async function signUpAndVerify(page: import("@playwright/test").Page, baseURL: string, mailbox: () => Promise<Array<{ kind: "verification" | "password-reset"; to: string; token: string }>>, name: string, email: string, fromCurrentPage = false) {
  if (!fromCurrentPage) await page.goto(`${baseURL}/sign-up`);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your mailbox" })).toBeVisible();
  const token = (await mailbox()).find((message) => message.kind === "verification" && message.to === email)?.token;
  expect(token).toBeTruthy();
  // Keep the confirmation UI in place so its destination-carrying Login link is exercised.
  await page.evaluate(async (verificationToken) => {
    const response = await fetch(`/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`);
    if (!response.ok) throw new Error(`email verification failed: ${response.status}`);
  }, token!);
}

test("verified mailbox account, pool entry, join, and closed-signup states use the isolated local Worker", async ({ page, browser, worker }) => {
  await page.goto(`${worker.baseURL}/`);
  await expect(page.getByRole("heading", { name: "Private football pool" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create account" }).first()).toBeVisible();
  await page.goto(`${worker.baseURL}/pools/new`);
  await expect(page).toHaveURL(/\/login\?next=%2Fpools%2Fnew$/);

  await page.getByRole("main").getByRole("link", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-up\?next=%2Fpools%2Fnew$/);
  await signUpAndVerify(page, worker.baseURL, worker.mailbox, "Owner", "owner-ui@example.test", true);
  await expect(page).toHaveURL(/\/sign-up\?next=%2Fpools%2Fnew$/);
  await worker.resetAuthLimiter();
  await page.getByRole("link", { name: "log in", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fpools%2Fnew$/);
  await page.getByLabel("Email address").fill("owner-ui@example.test");
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/pools\/new$/);
  await page.goto(`${worker.baseURL}/`);
  await expect(page.getByRole("heading", { name: "Your pools" })).toBeVisible();
  await expect(page.getByText("No pools yet")).toBeVisible();
  await page.goto(`${worker.baseURL}/pools/new`);
  await expect(page.getByRole("heading", { name: "Create a pool" })).toBeVisible();
  await page.getByLabel("Pool name").fill("Browser Pool");
  await page.getByLabel("Pool web address").fill("browser-pool");
  await page.getByLabel("Join password").fill("pool-password");
  // Dispatch without waiting for navigation so the real form's protected pending state is observable.
  await page.getByRole("button", { name: "Create pool" }).evaluate((button) => button.click());
  await expect(page.getByRole("button", { name: "Creating pool…" })).toBeDisabled();
  await expect(page).toHaveURL(/\/p\/browser-pool\/overview$/);
  const replay = await page.evaluate(async () => {
    const body = { poolName: "Replay Pool", slug: "replay-pool", password: "replay-password", idempotencyKey: "browser-create-replay" };
    const create = () => fetch("/api/pools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (response) => ({ status: response.status, body: await response.json() as { slug: string } }));
    return [await create(), await create()];
  });
  expect(replay[0]).toEqual(replay[1]);
  expect(replay[0]?.body.slug).toBe("replay-pool");
  await worker.triggerAlarm("browser-pool");

  // The loopback control synchronously runs the real Queue consumer, so this
  // authenticated discovery read is deterministic without a timing sleep.
  await expect(page.evaluate(async () => (await (await fetch("/api/pools")).json() as { memberships: Array<{ slug: string }> }).memberships.some((membership) => membership.slug === "browser-pool"))).resolves.toBe(true);
  await worker.triggerAlarm("replay-pool");
  await expect(page.evaluate(async () => (await (await fetch("/api/pools")).json() as { memberships: Array<{ slug: string }> }).memberships.filter((membership) => membership.slug === "replay-pool").length)).resolves.toBe(1);
  await page.goto(`${worker.baseURL}/`);
  await expect(page.getByRole("cell", { name: "Browser Pool" })).toBeVisible();
  // Existing members enter directly; this request is an actual browser session, not a route mock.
  await page.goto(`${worker.baseURL}/p/browser-pool`);
  await expect(page).toHaveURL(/\/p\/browser-pool\/overview$/);
  await page.goto(`${worker.baseURL}/`);
  await expect(page.getByRole("cell", { name: "Browser Pool" })).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Private football pool" })).toBeVisible();
  await expect(page.getByText("Browser Pool")).toHaveCount(0);

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await signUpAndVerify(member, worker.baseURL, worker.mailbox, "Member", "member-ui@example.test");
    await worker.resetAuthLimiter();
    await member.goto(`${worker.baseURL}/login?next=%2Fp%2Fbrowser-pool`);
    await member.getByLabel("Email address").fill("member-ui@example.test");
    await member.getByLabel("Password").fill("first-password");
    await member.getByRole("button", { name: "Log in" }).click();
    await expect(member.getByRole("heading", { name: "Join Browser Pool" })).toBeVisible();
    await member.getByLabel("Pool password").fill("wrong-password");
    await member.getByRole("button", { name: "Join pool" }).click();
    await expect(member.getByRole("alert")).toBeFocused();
    await expect(member.getByRole("alert")).toContainText("password was not accepted or signup is no longer available");
    await member.getByLabel("Pool password").fill("pool-password");
    await member.getByRole("button", { name: "Join pool" }).click();
    await expect(member).toHaveURL(/\/p\/browser-pool\/overview$/);
  } finally { await memberContext.close(); }

  await worker.resetAuthLimiter();
  await page.goto(`${worker.baseURL}/login?next=%2Fp%2Fbrowser-pool`);
  await page.getByLabel("Email address").fill("owner-ui@example.test");
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/p\/browser-pool(?:\/overview)?$/);
  await page.evaluate(async () => {
    const response = await fetch("/api/p/browser-pool/admin/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signupsOpen: false, idempotencyKey: crypto.randomUUID() }) });
    if (!response.ok) throw new Error(`closing signups failed: ${response.status}`);
  });
  const closedContext = await browser.newContext();
  const closed = await closedContext.newPage();
  try {
    await signUpAndVerify(closed, worker.baseURL, worker.mailbox, "Closed", "closed-ui@example.test");
    await worker.resetAuthLimiter();
    await closed.goto(`${worker.baseURL}/login?next=%2Fp%2Fbrowser-pool`);
    await closed.getByLabel("Email address").fill("closed-ui@example.test");
    await closed.getByLabel("Password").fill("first-password");
    await closed.getByRole("button", { name: "Log in" }).click();
    await expect(closed.getByRole("heading", { name: "This pool is not accepting members" })).toBeVisible();
    await expect(closed.getByText("No pool information is available here.")).toBeVisible();
    await expect(closed.getByText("Browser Pool")).toHaveCount(0);
  } finally { await closedContext.close(); }

  await page.goto(`${worker.baseURL}/forgot-password?next=%2Fpools%2Fnew`);
  await page.getByLabel("Email address").fill("owner-ui@example.test");
  await page.getByRole("button", { name: "Send reset instructions" }).click();
  await expect(page.getByRole("heading", { name: "Check your mailbox" })).toBeVisible();
  const reset = (await worker.mailbox()).find((message) => message.kind === "password-reset" && message.to === "owner-ui@example.test")?.token;
  expect(reset).toBeTruthy();
  await page.goto(`${worker.baseURL}/reset-password?token=${encodeURIComponent(reset!)}&next=%2Fpools%2Fnew`);
  await page.getByLabel("New password").fill("replacement-password");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fpools%2Fnew$/);
  await worker.resetAuthLimiter();
  await page.getByLabel("Email address").fill("owner-ui@example.test");
  await page.getByLabel("Password").fill("replacement-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/pools\/new$/);
});
