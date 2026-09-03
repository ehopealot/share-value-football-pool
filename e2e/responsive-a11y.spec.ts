import { createRequire } from "node:module";
import { test, expect } from "./fixtures/local-worker";
import { createActivePool, signIn } from "./fixtures/local-pool";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");

async function expectNoAxeViolations(page: import("@playwright/test").Page) {
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { rules: { "color-contrast": { enabled: false } } })).violations.map((violation: any) => ({ id: violation.id, nodes: violation.nodes.map((node: any) => node.html) })));
  expect(violations, page.url()).toEqual([]);
}

async function expectNoViewportOverflow(page: import("@playwright/test").Page) {
  const dimensions = () => page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll("*")].map((element) => ({ tag: element.tagName, className: (element as HTMLElement).className, right: Math.ceil(element.getBoundingClientRect().right) })).filter((element) => element.right > window.innerWidth + 1).slice(-8) }));
  await expect.poll(async () => (await dimensions()).scrollWidth <= (await dimensions()).width, { message: JSON.stringify(await dimensions()) }).toBe(true);
}

async function expectCompactOddsBoard(page: import("@playwright/test").Page) {
  const dimensions = () => page.locator(".odds-board").evaluate((table) => ({ table: table.scrollWidth, viewport: table.parentElement!.clientWidth }));
  await expect.poll(async () => (await dimensions()).table <= (await dimensions()).viewport + 1, { message: JSON.stringify(await dimensions()) }).toBe(true);
}

async function expectEvenGameRows(page: import("@playwright/test").Page) {
  const heights = () => page.locator(".odds-board tbody").evaluate((body) => [...body.querySelectorAll<HTMLTableRowElement>(".odds-game-top")].map((top) => ({ top: top.getBoundingClientRect().height, bottom: top.nextElementSibling!.getBoundingClientRect().height })));
  await expect.poll(async () => (await heights()).length > 0 && (await heights()).every((row) => Math.abs(row.top - row.bottom) <= 1)).toBe(true);
}

async function expectCenteredNicknameControls(page: import("@playwright/test").Page) {
  const centers = () => page.locator(".pool-nickname form").evaluate((form) => {
    const input = form.querySelector("input")!.getBoundingClientRect();
    const button = form.querySelector("button")!.getBoundingClientRect();
    return { input: input.top + input.height / 2, button: button.top + button.height / 2 };
  });
  await expect.poll(async () => Math.abs((await centers()).input - (await centers()).button) <= 1).toBe(true);
}

test("primary signed-out routes pass axe and expose keyboard-visible controls", async ({ page, worker }) => {
  for (const path of ["/", "/sign-up", "/login", "/forgot-password", "/reset-password"]) {
    await page.goto(`${worker.baseURL}${path}`);
    await expect(page.getByRole("main")).toBeVisible();
    await expectNoAxeViolations(page);
  }
  await page.goto(`${worker.baseURL}/login`);
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus-visible")).toHaveCount(1);
});

test("authenticated primary routes retain headers, tables, focus, errors, and reflow", async ({ page, worker }) => {
  const pool = await createActivePool(page, worker, { slug: "responsive-a11y", name: "Responsive A11y" });
  const primaryRoutes = [
    ["/", "Your pools"],
    ["/pools/new", "Create a pool"],
    [`/p/${pool.slug}/overview`, pool.name],
    [`/p/${pool.slug}/odds`, "Odds board"],
    [`/p/${pool.slug}/teaser`, "Teaser builder"],
    [`/p/${pool.slug}/my-wagers`, "My wagers"],
    [`/p/${pool.slug}/standings`, "Standings"],
    [`/p/${pool.slug}/activity`, "Activity"],
    [`/p/${pool.slug}/rules`, "Pool rules"],
    [`/p/${pool.slug}/board`, "Message board"],
    [`/p/${pool.slug}/admin/members`, "Member administration"],
    [`/p/${pool.slug}/admin/corrections`, "Wager corrections"],
    [`/p/${pool.slug}/admin/settings`, "Pool settings"],
    [`/p/${pool.slug}/admin/season`, "Season administration"],
    [`/p/${pool.slug}/admin/orders`, "Share orders"]
  ] as const;

  for (const [path, heading] of primaryRoutes) {
    await page.goto(`${worker.baseURL}${path}`);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expectNoAxeViolations(page);
  }

  await page.goto(`${worker.baseURL}/p/${pool.slug}/odds`);
  await expect(page.getByRole("link", { name: "Odds board" })).toHaveCSS("font-weight", "700");
  await expect(page.getByRole("table", { name: "Current odds" })).toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveCount(5);
  await expectEvenGameRows(page);
  await page.getByRole("checkbox").first().focus();
  await expect(page.locator(":focus-visible")).toHaveCount(1);
  await page.getByRole("checkbox").first().check();
  await page.getByLabel(/Risk in whole shares/).fill("1.5");
  await expect(page.getByText("Whole shares required.")).toBeVisible();
  await page.getByLabel(/Risk in whole shares/).fill("801");
  await expect(page.getByText("Max bet per side: 800 shares.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Place bets" })).toBeDisabled();
  await page.getByLabel(/Risk in whole shares/).fill("1");
  await expect(page.getByText("Selected bets total 1 shares; only 0 shares are available.")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${worker.baseURL}/p/${pool.slug}/odds`);
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expectNoViewportOverflow(page);
  await expectCompactOddsBoard(page);
  await expectEvenGameRows(page);
  await expect(page.getByText(/Current share value/)).toContainText("$0.00");
  await expect(page.getByText(/No shares issued yet/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Local Away/ })).toBeVisible();
  await page.getByRole("checkbox").first().check();
  await expect(page.locator(".selection-tray-list li")).not.toContainText("spread");
  const removeSelection = page.getByRole("button", { name: "Remove" });
  await expect(removeSelection).toHaveClass("selection-tray-remove");
  await expect(removeSelection).toHaveCSS("min-height", "44px");
  await expect(page.getByLabel(/Risk in whole shares/)).toBeVisible();
  await expect(page.locator(".selection-tray-list li > label")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Place bets" })).toHaveCSS("min-height", "44px");
  await page.goto(`${worker.baseURL}/p/${pool.slug}/my-wagers`);
  await expect(page.getByRole("heading", { name: "My wagers" })).toBeVisible();
  await expectNoViewportOverflow(page);
  await page.goto(`${worker.baseURL}/p/${pool.slug}/activity`);
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expectNoViewportOverflow(page);

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${worker.baseURL}/p/${pool.slug}/odds`);
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toHaveCSS("row-gap", "4px");
  await expectNoViewportOverflow(page);
  await expectCompactOddsBoard(page);
  await expectEvenGameRows(page);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("html")).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).scrollBehavior)).not.toBe("smooth");

  await page.goto(`${worker.baseURL}/p/${pool.slug}/overview`);
  await expectCenteredNicknameControls(page);
  await page.getByRole("textbox", { name: "Nickname" }).fill("A11y Alias");
  await page.getByRole("button", { name: "Save nickname" }).click();
  await expect(page.getByText("Pool nickname saved.")).toBeVisible();
  await page.goto(`${worker.baseURL}/p/${pool.slug}/standings`);
  await expect(page.getByText(/Current share value/)).toContainText("$0.00");
  await expect(page.getByText(/No shares issued yet/)).toBeVisible();
  await expect(page.getByRole("row", { name: /A11y Alias/ })).toBeVisible();

  await page.evaluate(async (slug) => {
    const response = await fetch("/__local-test/season", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug: slug, state: "closed" }) });
    if (!response.ok) throw new Error(`close fixture season failed: ${response.status}`);
  }, pool.slug);
  await page.goto(`${worker.baseURL}/p/${pool.slug}/history/${pool.seasonId}`);
  await expect(page.getByRole("heading", { name: `Archived season: ${pool.seasonLabel}` })).toBeVisible();
  await expectNoAxeViolations(page);
});

test("closed-signup state keeps the primary ribbon and gives a direct next step", async ({ page, browser, worker }) => {
  const pool = await createActivePool(page, worker, { slug: "closed-a11y", name: "Closed A11y" });
  await page.evaluate(async (slug) => {
    const response = await fetch(`/api/p/${slug}/admin/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signupsOpen: false, idempotencyKey: crypto.randomUUID() }) });
    if (!response.ok) throw new Error(`close signup failed: ${response.status}`);
  }, pool.slug);
  const context = await browser.newContext();
  const visitor = await context.newPage();
  try {
    await signIn(visitor, worker, { name: "Closed Visitor", email: "closed-visitor@example.test" });
    await visitor.goto(`${worker.baseURL}/p/${pool.slug}`);
    await expect(visitor.getByRole("heading", { name: "This pool is not accepting members" })).toBeVisible();
    await expect(visitor.getByRole("link", { name: "Return home" })).toBeVisible();
    await expectNoAxeViolations(visitor);
  } finally {
    await context.close();
  }
});
