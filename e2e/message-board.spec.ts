import { createRequire } from "node:module";
import { test, expect } from "./fixtures/local-worker";
import { createActivePool, signIn } from "./fixtures/local-pool";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");

test.setTimeout(180_000);

async function expectNoAxeViolations(page: import("@playwright/test").Page) {
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { rules: { "color-contrast": { enabled: false } } })).violations.map((violation: any) => ({ id: violation.id, nodes: violation.nodes.map((node: any) => node.html) })));
  expect(violations, page.url()).toEqual([]);
}

async function expectNoViewportOverflow(page: import("@playwright/test").Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("Message board lets active members exchange one-level replies with durable New markers and accessible mobile controls", async ({ page, browser, worker }) => {
  const pool = await createActivePool(page, worker, { slug: "message-board", name: "Message Board" });
  await page.goto(`${worker.baseURL}/p/${pool.slug}/board`);
  await expect(page.getByRole("heading", { name: "Message board" })).toBeVisible();

  for (const post of ["Opening thread", "Second thread"]) {
    if (post === "Opening thread") await page.evaluate(async (pathname) => {
      const response = await fetch("/__local-test/response-barrier", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "delay", delayMs: 750, pathname }) });
      if (!response.ok) throw new Error(`response barrier failed: ${response.status}`);
    }, `/api/p/${pool.slug}/board/posts`);
    await page.getByLabel("New post").fill(post);
    await expect(page.getByLabel("New post")).toHaveValue(post);
    await expect(page.getByRole("button", { name: "Post", exact: true })).toBeEnabled();
    const response = page.waitForResponse((candidate) => candidate.request().method() === "POST" && candidate.url().endsWith(`/api/p/${pool.slug}/board/posts`));
    const submit = page.getByRole("button", { name: "Post", exact: true }).click();
    if (post === "Opening thread") await expect(page.getByLabel("New post")).toBeDisabled();
    await submit;
    expect((await response).status()).toBe(200);
    await expect(page.getByText(post, { exact: true })).toBeVisible();
  }
  await expect(page.locator(".message-board-thread")).toHaveCount(2);
  await expect(page.locator(".message-board-thread-alt")).toHaveCount(1);
  await page.evaluate(async (pathname) => {
    const response = await fetch("/__local-test/response-barrier", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "drop", pathname }) });
    if (!response.ok) throw new Error(`response barrier failed: ${response.status}`);
  }, `/api/p/${pool.slug}/board/read`);
  await page.goto(`${worker.baseURL}/p/${pool.slug}/board`);
  await expect(page.getByRole("alert")).toContainText("Service unavailable.");
  await expect(page.getByRole("link", { name: "Return to the pool home" })).toBeVisible();
  await page.goto(`${worker.baseURL}/p/${pool.slug}/board`);
  await expect(page.getByText("Opening thread", { exact: true })).toBeVisible();

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await signIn(member, worker, { name: "Board Member", email: "board-member@example.test" });
    await member.goto(`${worker.baseURL}/p/${pool.slug}`);
    await expect(member.getByRole("heading", { name: "Join Message Board" })).toBeVisible();
    await member.getByLabel("Pool password").fill("local-pool-password");
    await member.getByRole("button", { name: "Join pool" }).click();
    await expect(member).toHaveURL(new RegExp(`/p/${pool.slug}/odds$`));

    const boardLink = member.getByRole("link", { name: /Message board.*New/ });
    await expect(boardLink).toBeVisible();
    const navigationLinks = await member.getByRole("navigation", { name: "Primary navigation" }).getByRole("link").allTextContents();
    expect(navigationLinks.at(-1)).toContain("Message board");
    await boardLink.focus();
    await expect(boardLink).toBeFocused();
    await member.keyboard.press("Enter");
    await expect(member).toHaveURL(new RegExp(`/p/${pool.slug}/board$`));
    await expect(member.getByText("Opening thread", { exact: true })).toBeVisible();
    await expect(member.getByRole("link", { name: "Message board", exact: true })).toBeVisible();

    const openingThread = member.locator(".message-board-thread").filter({ hasText: "Opening thread" });
    const replyButton = openingThread.getByRole("button", { name: "Reply to Message Board Commissioner" });
    await replyButton.click();
    const replyInput = openingThread.getByRole("textbox", { name: "Reply to Message Board Commissioner" });
    await replyInput.fill("I am in.");
    const replyControls = await replyButton.getAttribute("aria-controls");
    const postId = replyControls?.replace("message-board-reply-form-", "");
    expect(postId).toBeTruthy();
    await member.evaluate(async ({ slug, postId }) => {
      const response = await fetch("/__local-test/response-barrier", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "drop", pathname: `/api/p/${slug}/board/posts/${encodeURIComponent(postId!)}/replies` }) });
      if (!response.ok) throw new Error(`response barrier failed: ${response.status}`);
    }, { slug: pool.slug, postId });
    const replySubmit = openingThread.getByRole("button", { name: "Post reply" }).click();
    await expect(replyInput).toBeDisabled();
    await expect(replyButton).toBeDisabled();
    await replySubmit;
    await expect(member.getByRole("alert")).toContainText("Service unavailable.");
    await replyButton.click();
    await replyButton.click();
    await openingThread.getByRole("button", { name: "Post reply" }).click();
    await expect(openingThread.getByText("I am in.", { exact: true })).toHaveCount(1);
    await expect(openingThread.locator(".message-board-reply").getByRole("button")).toHaveCount(0);
    await expect(member.getByRole("link", { name: "Message board", exact: true })).toBeVisible();

    await page.goto(`${worker.baseURL}/p/${pool.slug}/overview`);
    await expect(page.getByRole("link", { name: /Message board.*New/ })).toBeVisible();
    await page.getByRole("link", { name: /Message board.*New/ }).click();
    await expect(page.getByRole("heading", { name: "Message board" })).toBeVisible();
    await expect(page.getByText("I am in.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Message board", exact: true })).toBeVisible();

    await member.setViewportSize({ width: 390, height: 844 });
    await member.goto(`${worker.baseURL}/p/${pool.slug}/board`);
    await expect(member.getByRole("heading", { name: "Message board" })).toBeVisible();
    await expectNoViewportOverflow(member);
    await expect(member.getByLabel("New post")).toBeVisible();
    await expect(member.getByRole("button", { name: "Post", exact: true })).toHaveCSS("min-height", "44px");
    await expect(member.locator(".message-board-reply-toggle").first()).toHaveCSS("min-height", "44px");
    await expectNoAxeViolations(member);
  } finally {
    await memberContext.close();
  }
});
