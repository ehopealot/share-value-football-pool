import { test, expect } from "./fixtures/local-worker";
import { createActivePool } from "./fixtures/local-pool";

async function fundPool(page: import("@playwright/test").Page, slug: string, shares = "3") {
  return page.evaluate(async ({ poolSlug, amount }) => {
    const viewResponse = await fetch(`/api/p/${poolSlug}/view`);
    if (!viewResponse.ok) throw new Error(`pool view failed: ${viewResponse.status}`);
    const view = await viewResponse.json() as { activeSeason: { id: string }; currentMember: { memberId: string } };
    const request = { seasonId: view.activeSeason.id, memberId: view.currentMember.memberId, mode: "shares", amountMicros: `${BigInt(amount) * 1_000_000n}`, idempotencyKey: crypto.randomUUID() };
    const quoteResponse = await fetch(`/api/p/${poolSlug}/admin/orders/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    if (!quoteResponse.ok) throw new Error(`order quote failed: ${quoteResponse.status}`);
    const quote = await quoteResponse.json() as { priceMicros: string; commandVersion: string };
    const executeResponse = await fetch(`/api/p/${poolSlug}/admin/orders/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, quote, reason: "Route isolation test", idempotencyKey: crypto.randomUUID() }) });
    if (!executeResponse.ok) throw new Error(`order execute failed: ${executeResponse.status}`);
    return executeResponse.status;
  }, { poolSlug: slug, amount: shares });
}

async function navigateWithinSpa(page: import("@playwright/test").Page, pathname: string) {
  await page.evaluate((nextPath) => { window.history.pushState({}, "", nextPath); window.dispatchEvent(new PopStateEvent("popstate")); }, pathname);
}

async function signInOwner(
  page: import("@playwright/test").Page,
  baseURL: string,
  mailbox: () => Promise<
    Array<{ kind: "verification"; to: string; token: string }>
  >,
) {
  // The fixture uses random loopback ports; discard a cookie from a reused port before real sign-up.
  await page.context().clearCookies();
  await page.goto(`${baseURL}/sign-up`);
  await page.getByLabel("Name").fill("Wager Owner");
  await page.getByLabel("Email address").fill("wager-owner@example.test");
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("link", { name: "log in", exact: true }).click();
  await page.getByLabel("Email address").fill("wager-owner@example.test");
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(`${baseURL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/$`));
  await expect(page.getByRole("heading", { name: "Your pools" })).toBeVisible();
}

test("local Wrangler serves the freshly built SPA for sign-up and deep browser routes", async ({
  page,
  worker,
}) => {
  const signUp = await page.goto(`${worker.baseURL}/sign-up`);
  expect(signUp?.headers()["content-type"]).toContain("text/html");
  await expect(page.getByTestId("current-sign-up-spa")).toBeVisible();

  const deepRoute = await page.goto(
    `${worker.baseURL}/p/not-yet-created/overview`,
  );
  expect(deepRoute?.headers()["content-type"]).toContain("text/html");
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
});

test("a pending straight quote cannot leak into a newly selected pool", async ({ page, worker }) => {
  const source = await createActivePool(page, worker, { slug: "route-source", name: "Route Source" });
  expect(await fundPool(page, source.slug)).toBe(200);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Route Destination");
  await page.getByLabel("Pool web address").fill("route-destination");
  await page.getByLabel("Join password").fill("route-destination-password");
  await page.getByRole("button", { name: "Create pool" }).click();
  await expect(page).toHaveURL(/\/p\/route-destination\/odds$/);

  await page.goto(`${worker.baseURL}/p/${source.slug}/odds`);
  await page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }).check();
  await page.getByLabel(/^Risk in whole shares for .*: spread/).fill("1");
  expect(await page.evaluate(async (poolSlug) => (await fetch("/__local-test/response-barrier", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "drop", pathname: `/api/p/${poolSlug}/wagers/straight/quote` }) })).status, source.slug)).toBe(200);
  await page.getByRole("button", { name: "Place bets" }).click();
  await expect(page.getByRole("heading", { name: "Reviewing straight wagers" })).toBeVisible();

  await navigateWithinSpa(page, "/p/route-destination/odds");
  await expect(page.getByRole("heading", { name: "Odds board" })).toBeVisible();
  await page.waitForTimeout(6_000);
  await expect(page.getByRole("heading", { name: "Odds board" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reviewing straight wagers" })).toHaveCount(0);
});

test("a pending straight placement cannot leak into a newly selected pool", async ({ page, worker }) => {
  const source = await createActivePool(page, worker, { slug: "placement-route-source", name: "Placement Route Source" });
  expect(await fundPool(page, source.slug)).toBe(200);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Placement Route Destination");
  await page.getByLabel("Pool web address").fill("placement-route-destination");
  await page.getByLabel("Join password").fill("placement-route-destination-password");
  await page.getByRole("button", { name: "Create pool" }).click();
  await expect(page).toHaveURL(/\/p\/placement-route-destination\/odds$/);

  await page.goto(`${worker.baseURL}/p/${source.slug}/odds`);
  await page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }).check();
  await page.getByLabel(/^Risk in whole shares for .*: spread/).fill("1");
  await page.getByRole("button", { name: "Place bets" }).click();
  await expect(page.getByRole("heading", { name: "Review straight wagers" })).toBeVisible();
  expect(await page.evaluate(async (poolSlug) => (await fetch("/__local-test/response-barrier", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "drop", pathname: `/api/p/${poolSlug}/wagers/straight/place` }) })).status, source.slug)).toBe(200);
  await page.getByRole("button", { name: "Place 1 wager" }).click();

  await navigateWithinSpa(page, "/p/placement-route-destination/odds");
  await expect(page.getByRole("heading", { name: "Odds board" })).toBeVisible();
  await page.waitForTimeout(8_000);
  await expect(page.getByRole("heading", { name: "Odds board" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review straight wagers" })).toHaveCount(0);
});

test("a pending teaser quote cannot leak into a newly selected pool", async ({ page, worker }) => {
  const source = await createActivePool(page, worker, { slug: "teaser-route-source", name: "Teaser Route Source" });
  expect(await fundPool(page, source.slug)).toBe(200);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Teaser Route Destination");
  await page.getByLabel("Pool web address").fill("teaser-route-destination");
  await page.getByLabel("Join password").fill("teaser-route-destination-password");
  await page.getByRole("button", { name: "Create pool" }).click();
  await expect(page).toHaveURL(/\/p\/teaser-route-destination\/odds$/);

  await page.goto(`${worker.baseURL}/p/${source.slug}/odds`);
  await page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }).check();
  await page.getByRole("checkbox", { name: /^O \d+(\.\d+)?$/ }).check();
  await page.getByRole("button", { name: "Build teaser" }).click();
  await page.getByLabel("Risk", { exact: true }).fill("1");
  expect(await page.evaluate(async (poolSlug) => (await fetch("/__local-test/response-barrier", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "drop", pathname: `/api/p/${poolSlug}/wagers/teasers/quote` }) })).status, source.slug)).toBe(200);
  await page.getByRole("button", { name: "Review teaser wager" }).click();
  await expect(page.getByRole("heading", { name: "Reviewing teaser wager" })).toBeVisible();

  await navigateWithinSpa(page, "/p/teaser-route-destination/teaser");
  await expect(page.getByRole("heading", { name: "Teaser builder" })).toBeVisible();
  await page.waitForTimeout(6_000);
  await expect(page.getByRole("heading", { name: "Teaser builder" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Confirm teaser wager" })).toHaveCount(0);
});

test("commissioner funds shares and confirms a canonical straight wager through the isolated local Worker", async ({
  page,
  worker,
}) => {
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Orders Pool");
  await page.getByLabel("Pool web address").fill("orders-pool");
  await page.getByLabel("Join password").fill("orders-password");
  await page.getByRole("button", { name: "Create pool" }).click();
  await expect(page).toHaveURL(/\/p\/orders-pool\/odds$/);
  await page.getByRole("link", { name: "Pool home" }).click();
  await expect(
    page.getByRole("heading", { name: "Orders Pool" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Season", exact: true }).click();
  await page.getByLabel("Season label").fill("2026");
  await page.getByRole("button", { name: "Create season" }).click();
  await page.getByRole("button", { name: "Open season" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await page.getByLabel("Amount").fill("3");
  await page.getByRole("button", { name: "Quote order" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm share order" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm order" }).click();
  await expect(page).toHaveURL(/\/p\/orders-pool\/overview$/);
  await page.getByRole("link", { name: "Odds board", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Odds board" })).toBeVisible();
  await page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }).check();
  const straightQuoteBodies: Record<string, unknown>[] = [];
  const straightPlacementBodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().includes("/wagers/straight/quote"))
      straightQuoteBodies.push(request.postDataJSON() as Record<string, unknown>);
    if (request.url().includes("/wagers/straight/place"))
      straightPlacementBodies.push(request.postDataJSON() as Record<string, unknown>);
  });
  // The delay happens only after the real quote completes; pending controls must
  // remain unavailable until that completed response is released.
  expect(await page.evaluate(async () => (await fetch("/__local-test/response-barrier", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "delay", delayMs: 1_000, pathname: "/api/p/orders-pool/wagers/straight/quote" }) })).status)).toBe(200);
  await page.getByLabel(/^Risk in whole shares for .*: spread/).fill("1");
  await page.getByRole("button", { name: "Place bets" }).click();
  await expect(page.getByRole("heading", { name: "Reviewing straight wagers" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review straight wagers" })).toBeVisible();
  await page.getByRole("button", { name: "Back to board" }).click();
  // A withheld completed quote rejects in bounded time and retry re-quotes the
  // same semantic identity rather than minting replacement authority.
  expect(await page.evaluate(async () => (await fetch("/__local-test/response-barrier", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "drop", pathname: "/api/p/orders-pool/wagers/straight/quote" }) })).status)).toBe(200);
  const droppedQuoteAt = Date.now();
  await page.getByRole("button", { name: "Place bets" }).click();
  await expect(page.getByRole("heading", { name: "Placement results" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Odds unavailable");
  expect(Date.now() - droppedQuoteAt).toBeLessThan(10_000);
  await page.getByRole("button", { name: "Back to odds board" }).click();
  await page.getByRole("button", { name: "Place bets" }).click();
  await expect(page.getByRole("heading", { name: "Review straight wagers" })).toBeVisible();
  expect(straightQuoteBodies).toHaveLength(3);
  expect(straightQuoteBodies[2]!.wagerId).toBe(straightQuoteBodies[1]!.wagerId);
  expect(straightQuoteBodies[2]!.leg).toEqual(straightQuoteBodies[1]!.leg);
  expect(straightQuoteBodies[2]!.quoteKey).not.toBe(straightQuoteBodies[1]!.quoteKey);
  // The real first placement completes before its response is withheld. The
  // browser automatically replays the exact frozen placement after two seconds.
  expect(await page.evaluate(async () => (await fetch("/__local-test/response-barrier", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "drop", pathname: "/api/p/orders-pool/wagers/straight/place" }) })).status)).toBe(200);
  await page.getByRole("button", { name: "Place 1 wager" }).click();
  await expect.poll(() => straightPlacementBodies, { timeout: 15_000 }).toHaveLength(2);
  expect(straightPlacementBodies[1]).toEqual(straightPlacementBodies[0]);
  await expect(page.getByRole("heading", { name: "Placement results" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("link", { name: "My wagers" }).click();
  await expect(page).toHaveURL(/\/p\/orders-pool\/my-wagers$/);
  await page.getByRole("link", { name: "Return to games", exact: true }).click();
  await page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }).check();
  let straightQuoteRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/wagers/straight/quote")
    )
      straightQuoteRequests++;
  });
  await page.getByLabel(/^Risk in whole shares for .*: spread/).fill("1.5");
  await expect(page.getByText("Whole shares required.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Place bets" })).toBeDisabled();
  await expect.poll(() => straightQuoteRequests).toBe(0);
  await page.getByLabel(/^Risk in whole shares for .*: spread/).fill("1");
  await page.getByRole("button", { name: "Place bets" }).click();
  await expect(
    page.getByRole("heading", { name: "Review straight wagers" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Local Away/ }),
  ).toContainText("1");
  await page.getByRole("button", { name: "Place 1 wager" }).click();
  await expect(page.getByRole("heading", { name: "Placement results" })).toBeVisible();
  await page.getByRole("link", { name: "My wagers" }).click();
  await expect(page).toHaveURL(/\/p\/orders-pool\/my-wagers$/);
  await expect(page.getByRole("heading", { name: "Open bets" })).toBeVisible();
  const openBets = page.getByRole("table", { name: "Open bets" });
  await expect(openBets.getByRole("row", { name: /Local Away \(\+3\) at Local Home.*1 \+100.*2\.00/ }).first()).toBeVisible();
  await expect(page.getByText("Bets cannot be canceled after placement.")).toBeVisible();
  // The browser renders the real durable balance without ever converting its
  // canonical integer micros through Number.
  const largeOrder = await page.evaluate(async () => {
    const view = (await (await fetch("/api/p/orders-pool/view")).json()) as { activeSeason: { id: string }; currentMember: { memberId: string } };
    const quoteRequest = { seasonId: view.activeSeason.id, memberId: view.currentMember.memberId, mode: "shares", amountMicros: "9007199254740992", idempotencyKey: crypto.randomUUID() };
    const quote = await (await fetch("/api/p/orders-pool/admin/orders/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(quoteRequest) })).json() as { priceMicros: string; commandVersion: string };
    return (await fetch("/api/p/orders-pool/admin/orders/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...quoteRequest, quote: { priceMicros: quote.priceMicros, commandVersion: quote.commandVersion }, reason: "Browser large canonical integer", idempotencyKey: crypto.randomUUID() }) })).status;
  });
  expect(largeOrder).toBe(200);
  await page.goto(`${worker.baseURL}/p/orders-pool/overview`);
  await expect(page.getByRole("row", { name: /Available shares/i })).toContainText("9007199255.74");
});

test("commissioner confirms an in-page reversal and preserves immutable order history", async ({
  page,
  worker,
}) => {
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Reversal Pool");
  await page.getByLabel("Pool web address").fill("reversal-pool");
  await page.getByLabel("Join password").fill("reversal-password");
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
  await page.getByRole("link", { name: "Share orders" }).click();
  await expect(
    page.getByRole("heading", { name: "Share orders" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reverse with reason" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm share-order reversal" }),
  ).toBeVisible();
  await page.getByLabel("Reason").fill("Correcting an accidental issue");
  await page.getByRole("button", { name: "Confirm reversal" }).click();
  await expect(page.getByText("Already reversed")).toBeVisible();
  await expect(page.getByText("Reversal record")).toBeVisible();
  await expect(page.getByText("Correcting an accidental issue")).toBeVisible();
});

test("the real browser uses whole-share defaults, filters canonical odds, and blocks an insufficient risk before review", async ({
  page,
  worker,
}) => {
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Recovery Pool");
  await page.getByLabel("Pool web address").fill("recovery-pool");
  await page.getByLabel("Join password").fill("recovery-password");
  await page.getByRole("button", { name: "Create pool" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Season", exact: true }).click();
  await page.getByLabel("Season label").fill("2026");
  await page.getByLabel("Default amount").fill("1");
  await page.getByRole("button", { name: "Create season" }).click();
  await page.getByRole("button", { name: "Open season" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await expect(page.getByLabel("Amount")).toHaveValue("1");
  await page.getByLabel("Amount").fill("3");
  await page.getByRole("button", { name: "Quote order" }).click();
  await page.getByRole("button", { name: "Confirm order" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await page.getByRole("link", { name: "Odds board", exact: true }).click();

  await page.getByLabel("League").selectOption("nfl");
  await expect(
    page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /^O \d+(\.\d+)?$/ }),
  ).toHaveCount(1);

  const selection = page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ });
  await selection.focus();
  await page.keyboard.press("Space");
  await expect(selection).toBeChecked();
  await page.getByLabel(/^Risk in whole shares for .*: spread/).fill("4");
  await expect(page.locator(".bet-slip-error")).toHaveText("Selected bets total 4 shares; only 3 shares are available.");
  await expect(page.getByRole("button", { name: "Place bets" })).toBeDisabled();
  await page.goto(`${worker.baseURL}/p/recovery-pool/overview`);
  await expect(
    page.getByRole("row", { name: /Available shares/i }),
  ).toContainText("3.00");
});

test("a two-leg teaser uses a placement key distinct from its quote key", async ({
  page,
  worker,
}) => {
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Teaser Pool");
  await page.getByLabel("Pool web address").fill("teaser-pool");
  await page.getByLabel("Join password").fill("teaser-password");
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
  await expect(page).toHaveURL(/\/overview$/);
  await page.getByRole("link", { name: "Odds board", exact: true }).click();
  await page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }).check();
  await page.getByRole("checkbox", { name: /^O \d+(\.\d+)?$/ }).check();
  await page.getByRole("button", { name: "Build teaser" }).click();
  await expect(page.getByRole("heading", { name: "Teaser builder" })).toBeVisible();
  await expect(page.getByText(/Local Away \+9/)).toBeVisible();
  let teaserQuoteRequests = 0;
  const teaserQuoteBodies: Record<string, unknown>[] = [];
  const teaserPlacementBodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().includes("/wagers/teasers/quote")) {
      teaserQuoteRequests++;
      teaserQuoteBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
    if (request.url().includes("/wagers/teasers/place"))
      teaserPlacementBodies.push(
        request.postDataJSON() as Record<string, unknown>,
      );
  });
  await page.getByLabel("Risk", { exact: true }).fill("1.5");
  await expect(page.getByRole("alert")).toHaveText("Whole shares required.");
  await expect(page.getByRole("button", { name: "Review teaser wager" })).toBeDisabled();
  await expect.poll(() => teaserQuoteRequests).toBe(0);
  await page.getByLabel("Risk", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Review teaser wager" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm teaser wager" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Local Away at Local Home/).first(),
  ).toBeVisible();
  await expect(page.getByText(/Odds:/)).toBeVisible();
  await expect(page.getByText(/Win:/)).toBeVisible();
  await expect(page.getByText(/Payout:/)).toBeVisible();
  await expect(page.getByText(/line 9/)).toBeVisible();
  // A real LINE_CHANGED plus a dropped completed odds read retains the frozen confirmation and its keys.
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch("/__local-test/offer", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              eventId: "local-nfl-upcoming",
              market: "spread",
              selection: "away",
              price: -115,
              point: 4.5,
              offerVersion: "teaser-v2",
            }),
          })
        ).status,
    ),
  ).toBe(200);
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch("/__local-test/response-barrier", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: "drop",
              pathname: "/api/p/teaser-pool/odds",
            }),
          })
        ).status,
    ),
  ).toBe(200);
  await page.getByRole("button", { name: "Place teaser" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Odds unavailable",
  );
  await expect(
    page.getByRole("heading", { name: "Confirm teaser wager" }),
  ).toBeVisible();
  await expect.poll(() => teaserPlacementBodies).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      JSON.parse(
        sessionStorage.getItem("share-pool:teaser:teaser-pool") ?? "[]",
      ),
    ),
  ).toHaveLength(2);
  await page.getByRole("button", { name: "Place teaser" }).click();
  await expect.poll(() => teaserPlacementBodies).toHaveLength(2);
  expect(teaserPlacementBodies[1]).toEqual(teaserPlacementBodies[0]);
  await expect(
    page.getByRole("heading", { name: "Confirm teaser wager" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Teaser builder" }),
  ).toBeVisible();
  await expect(page.getByLabel("Risk", { exact: true })).toHaveValue("1");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Teaser builder" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(2);
  // The recovered current board is authoritative: a terminal rejection restores its current legs and persisted slip.
  await page.getByLabel("Risk", { exact: true }).fill("1");
  await page.getByLabel("6.5 points").check();
  await expect(page.getByLabel("6.5 points")).toBeChecked();
  await page.getByRole("button", { name: "Review teaser wager" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm teaser wager" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch("/__local-test/offer-state", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              eventId: "local-nfl-upcoming",
              market: "spread",
              state: "locked",
            }),
          })
        ).status,
    ),
  ).toBe(200);
  await page.getByRole("button", { name: "Place teaser" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Event has started.",
  );
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Confirm teaser wager" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Teaser builder" }),
  ).toBeVisible();
  await expect(page.getByLabel("Risk", { exact: true })).toHaveValue("1");
  await expect(page.getByLabel("6.5 points")).toBeChecked();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(2);
  expect(
    await page.evaluate(() =>
      JSON.parse(
        sessionStorage.getItem("share-pool:teaser:teaser-pool") ?? "[]",
      ),
    ),
  ).toHaveLength(2);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Teaser builder" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(2);
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch("/__local-test/offer-state", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              eventId: "local-nfl-upcoming",
              market: "spread",
              state: "current",
            }),
          })
        ).status,
    ),
  ).toBe(200);
  // Re-review current v2 terms, then prove an authoritative board with the selected leg absent clears both editor and slip.
  await page.getByLabel("Risk", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Review teaser wager" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm teaser wager" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch("/__local-test/offer", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              eventId: "local-nfl-upcoming",
              market: "spread",
              selection: "away",
              price: -115,
              point: 4.5,
              offerVersion: "teaser-v3-unavailable",
              removeSelection: true,
            }),
          })
        ).status,
    ),
  ).toBe(200);
  await page.getByRole("button", { name: "Place teaser" }).click();
  const terminalRecovery = page.getByText("A teaser line changed and one or more legs are no longer available. Choose current legs and review again.", { exact: true });
  await expect(terminalRecovery).toBeVisible();
  await expect(terminalRecovery).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Confirm teaser wager" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Teaser builder" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.parse(
        sessionStorage.getItem("share-pool:teaser:teaser-pool") ?? "[]",
      ),
    ),
  ).toEqual([]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  // Re-seed and rebuild only from the real authoritative board before final placement.
  expect(
    await page.evaluate(
      async () =>
        (await fetch("/__local-test/seed", { method: "POST" })).status,
    ),
  ).toBe(200);
  await page.getByRole("link", { name: "odds board", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Odds board" })).toBeVisible();
  await page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }).check();
  await page.getByRole("checkbox", { name: /^O \d+(\.\d+)?$/ }).check();
  await page.getByRole("button", { name: "Build teaser" }).click();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(2);
  await page.getByLabel("Risk", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Review teaser wager" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm teaser wager" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Place teaser" }).click();
  await expect(page).toHaveURL(/\/p\/teaser-pool\/my-wagers$/);
  expect(teaserQuoteBodies).toHaveLength(4);
  expect(teaserPlacementBodies).toHaveLength(5);
  expect(teaserQuoteBodies[1]!.quoteKey).not.toBe(
    teaserQuoteBodies[0]!.quoteKey,
  );
  // This journey deliberately reloads after stale recovery to prove slip persistence;
  // the mounted remount begins a new semantic wager identity.
  expect(teaserQuoteBodies[1]!.wagerId).not.toBe(teaserQuoteBodies[0]!.wagerId);
  expect(teaserQuoteBodies[2]!.quoteKey).not.toBe(
    teaserQuoteBodies[1]!.quoteKey,
  );
  expect(teaserQuoteBodies[2]!.wagerId).not.toBe(teaserQuoteBodies[1]!.wagerId);
  expect(teaserQuoteBodies[3]!.quoteKey).not.toBe(
    teaserQuoteBodies[2]!.quoteKey,
  );
  expect(teaserQuoteBodies[3]!.wagerId).not.toBe(teaserQuoteBodies[2]!.wagerId);
  expect(teaserPlacementBodies[0]!.mutationKey).toBe(
    teaserPlacementBodies[1]!.mutationKey,
  );
  expect(teaserPlacementBodies[1]).toEqual(teaserPlacementBodies[0]);
  expect(teaserPlacementBodies[2]!.mutationKey).not.toBe(
    teaserPlacementBodies[1]!.mutationKey,
  );
  expect(teaserPlacementBodies[3]!.mutationKey).not.toBe(
    teaserPlacementBodies[2]!.mutationKey,
  );
  expect(teaserPlacementBodies[4]!.mutationKey).not.toBe(
    teaserPlacementBodies[3]!.mutationKey,
  );
  expect(teaserPlacementBodies[4]!.mutationKey).not.toBe(
    teaserQuoteBodies[3]!.quoteKey,
  );
  await expect(page.getByRole("heading", { name: "Open bets" })).toBeVisible();
  const openBets = page.getByRole("table", { name: "Open bets" });
  await expect(openBets.locator(".wager-legs > span").filter({ hasText: /Local Away.*Local Home/ })).toHaveCount(2);
  await expect(openBets.getByRole("row", { name: /1 [+-]\d+.*1\.83/ })).toBeVisible();
});

test("LINE_CHANGED discards review, unmounts confirmation, and requires a fresh explicit straight re-quote", async ({
  page,
  worker,
}) => {
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Line Change Pool");
  await page.getByLabel("Pool web address").fill("line-change-pool");
  await page.getByLabel("Join password").fill("line-change-password");
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
  await expect(page).toHaveURL(/\/overview$/);
  await page.getByRole("link", { name: "Odds board", exact: true }).click();
  await page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }).check();
  const quoteBodies: Record<string, unknown>[] = [];
  const placementBodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().includes("/wagers/straight/quote"))
      quoteBodies.push(request.postDataJSON() as Record<string, unknown>);
    if (request.url().includes("/wagers/straight/place"))
      placementBodies.push(request.postDataJSON() as Record<string, unknown>);
  });
  await page.getByLabel(/^Risk in whole shares for .*: spread/).fill("1");
  // Turn D1 over after slip selection but before quotation: the stale request
  // must not become a durable v2 snapshot under its v1 identity.
  expect(await page.evaluate(async () => (await fetch("/__local-test/offer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "local-nfl-upcoming", market: "spread", selection: "away", price: -115, point: 4.5, offerVersion: "local-quote-turnover-v2" }) })).status)).toBe(200);
  await page.getByRole("button", { name: "Place bets" }).click();
  // The slip re-resolves against a freshly fetched board, so the turned-over v1
  // identity is never quoted: the browser sends only the current v2 terms.
  await expect(page.getByRole("heading", { name: "Review straight wagers" })).toBeVisible();
  expect(quoteBodies).toHaveLength(1);
  await expect(page.getByRole("row", { name: /Local Away/ })).toContainText("4.5");
  const quoteReplay = await page.evaluate(
    async (body) =>
      Promise.all(
        [0, 1].map(async () => {
          const response = await fetch(
            "/api/p/line-change-pool/wagers/straight/quote",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          return { status: response.status, body: await response.json() };
        }),
      ),
    quoteBodies[0],
  );
  expect(quoteReplay[0]).toEqual(quoteReplay[1]);
  const changed = await page.evaluate(
    async () =>
      (
        await fetch("/__local-test/offer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            eventId: "local-nfl-upcoming",
            market: "spread",
            selection: "away",
            price: -115,
            point: 4.5,
            offerVersion: "local-line-change-v3",
          }),
        })
      ).status,
  );
  expect(changed).toBe(200);
  await page.getByRole("button", { name: "Place 1 wager" }).click();
  await expect(page.getByRole("heading", { name: "Placement results" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Line changed.");
  await page.getByRole("button", { name: "Back to odds board" }).click();
  await expect(
    page.getByRole("checkbox", { name: "Local Away +4.5", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Place bets" }).click();
  await expect(
    page.getByRole("heading", { name: "Review straight wagers" }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /Local Away/ })).toContainText("4.5");
  // A fetched board that lacks the selected semantic outcome is terminal for this selection, unlike a dropped read.
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch("/__local-test/offer", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              eventId: "local-nfl-upcoming",
              market: "spread",
              selection: "away",
              price: -115,
              point: 4.5,
              offerVersion: "local-line-change-v3-unavailable",
              removeSelection: true,
            }),
          })
        ).status,
    ),
  ).toBe(200);
  await page.getByRole("button", { name: "Place 1 wager" }).click();
  await expect(page.getByRole("heading", { name: "Placement results" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Line changed.");
  await page.getByRole("button", { name: "Back to odds board" }).click();
  await expect(page.getByText("(no longer available)")).toBeVisible();
  await page.getByRole("button", { name: "Place bets" }).click();
  await expect(page.getByRole("heading", { name: "Placement results" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("no longer available on the board");
  expect(
    await page.evaluate(
      async () =>
        (await fetch("/__local-test/seed", { method: "POST" })).status,
    ),
  ).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Odds board" })).toBeVisible();
  await page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }).check();
  await page.getByLabel(/^Risk in whole shares for .*: spread/).fill("1");
  await page.getByRole("button", { name: "Place bets" }).click();
  await expect(
    page.getByRole("heading", { name: "Review straight wagers" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Place 1 wager" }).click();
  await expect(page.getByRole("heading", { name: "Placement results" })).toBeVisible();
  await page.getByRole("link", { name: "My wagers" }).click();
  await expect(page).toHaveURL(/\/p\/line-change-pool\/my-wagers$/);
  // The initial v2 quote, its two raw replay probes, the v3 re-review, then a
  // semantic re-seed with a fresh slip identity.
  expect(quoteBodies).toHaveLength(5);
  expect(quoteBodies[1]).toEqual(quoteBodies[0]);
  expect(quoteBodies[2]).toEqual(quoteBodies[0]);
  expect(quoteBodies[3]!.wagerId).toBe(quoteBodies[0]!.wagerId);
  expect(quoteBodies[3]!.quoteKey).not.toBe(quoteBodies[0]!.quoteKey);
  expect(quoteBodies[4]!.quoteKey).not.toBe(quoteBodies[3]!.quoteKey);
  expect(quoteBodies[4]!.wagerId).not.toBe(quoteBodies[3]!.wagerId);
  expect(placementBodies).toHaveLength(3);
  expect(placementBodies[0]!.mutationKey).not.toBe(quoteBodies[0]!.quoteKey);
  expect(placementBodies[1]!.mutationKey).not.toBe(
    placementBodies[0]!.mutationKey,
  );
  expect(placementBodies[2]!.mutationKey).not.toBe(
    placementBodies[1]!.mutationKey,
  );
  await expect(page.getByRole("row")).toHaveCount(2);
});

async function joinSecondMember(
  browser: import("@playwright/test").Browser,
  worker: {
    baseURL: string;
    mailbox: () => Promise<
      Array<{
        kind: "verification" | "password-reset";
        to: string;
        token: string;
      }>
    >;
  },
  slug: string,
  password: string,
) {
  const context = await browser.newContext();
  const member = await context.newPage();
  try {
    await member.goto(`${worker.baseURL}/sign-up`);
    await member.getByLabel("Name").fill("Quoted Member");
    await member.getByLabel("Email address").fill("quoted-member@example.test");
    await member.getByLabel("Password").fill("first-password");
    await member.getByRole("button", { name: "Create account" }).click();
    await member.getByRole("link", { name: "log in", exact: true }).click();
    await member.getByLabel("Email address").fill("quoted-member@example.test");
    await member.getByLabel("Password").fill("first-password");
    await member.getByRole("button", { name: "Log in" }).click();
    await expect(member).toHaveURL(`${worker.baseURL}/`);
    await expect(member.getByRole("heading", { name: "Your pools" })).toBeVisible();
    await member.goto(`${worker.baseURL}/p/${slug}`);
    await member.getByLabel("Pool password").fill(password);
    await member.getByRole("button", { name: "Join pool" }).click();
    await expect(member).toHaveURL(new RegExp(`/p/${slug}/odds$`));
  } finally {
    await context.close();
  }
}

test("ORDER_QUOTE_STALE discards review, unmounts confirmation, and requires a fresh explicit re-quote for both modes", async ({
  page,
  browser,
  worker,
}) => {
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Stale Order Pool");
  await page.getByLabel("Pool web address").fill("stale-order-pool");
  await page.getByLabel("Join password").fill("stale-order-password");
  await page.getByRole("button", { name: "Create pool" }).click();
  await joinSecondMember(
    browser,
    worker,
    "stale-order-pool",
    "stale-order-password",
  );
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Season", exact: true }).click();
  await page.getByLabel("Season label").fill("2026");
  await page.getByLabel("Default amount").fill("1");
  await page.getByRole("button", { name: "Create season" }).click();
  await page.getByRole("button", { name: "Open season" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await expect(page.getByLabel("Amount")).toHaveValue("1");
  await page.getByLabel("Member").selectOption({ label: "Quoted Member" });
  const quotedMemberId = await page.getByLabel("Member").inputValue();
  expect(quotedMemberId).toBeTruthy();
  const orderQuoteBodies: Record<string, unknown>[] = [];
  const orderExecutionBodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().includes("/admin/orders/quote")) orderQuoteBodies.push(request.postDataJSON() as Record<string, unknown>);
    if (request.url().includes("/admin/orders/execute")) orderExecutionBodies.push(request.postDataJSON() as Record<string, unknown>);
  });

  for (const mode of ["shares", "value"] as const) {
    const quoteStart = orderQuoteBodies.length;
    const executionStart = orderExecutionBodies.length;
    await page.getByLabel("Order form").selectOption(mode);
    const input = page.getByLabel("Amount");
    await input.fill("1");
    await page.getByRole("button", { name: "Quote order" }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm share order" }),
    ).toBeVisible();
    const reviewedQuotes = () => orderQuoteBodies.slice(quoteStart).filter((body) => body.memberId === quotedMemberId && body.amountMicros === "1000000" && body.mode === mode);
    await expect.poll(() => reviewedQuotes()).toHaveLength(1);
    const originalQuote = reviewedQuotes()[0]!;
    expect(originalQuote.idempotencyKey).toEqual(expect.any(String));
    const bumped = await page.evaluate(async () => {
      const view = (await (
        await fetch("/api/p/stale-order-pool/view")
      ).json()) as {
        activeSeason: { id: string } | null;
        currentMember: { memberId: string };
      };
      if (!view.activeSeason) throw new Error("Expected an active season");
      const quoteResponse = await fetch(
        "/api/p/stale-order-pool/admin/orders/quote",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            seasonId: view.activeSeason.id,
            memberId: view.currentMember.memberId,
            mode: "shares",
            amountMicros: "1000000",
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      const quote = await quoteResponse.json();
      const executeResponse = await fetch(
        "/api/p/stale-order-pool/admin/orders/execute",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            seasonId: view.activeSeason.id,
            memberId: view.currentMember.memberId,
            mode: "shares",
            amountMicros: "1000000",
            quote: {
              priceMicros: quote.priceMicros,
              commandVersion: quote.commandVersion,
            },
            reason: "Advance price version",
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      return executeResponse.status;
    });
    expect(bumped).toBe(200);
    await page.getByRole("button", { name: "Confirm order" }).click();
    const reviewedExecutions = () => orderExecutionBodies.slice(executionStart).filter((body) => body.memberId === quotedMemberId && body.amountMicros === "1000000" && body.mode === mode);
    await expect.poll(() => reviewedExecutions()).toHaveLength(1);
    const rejectedExecution = reviewedExecutions()[0]!;
    expect(rejectedExecution.idempotencyKey).toEqual(expect.any(String));
    expect(rejectedExecution.idempotencyKey).not.toBe(originalQuote.idempotencyKey);
    await expect(page.getByRole("alert")).toHaveText(
      "Share price changed.",
    );
    await expect(page.getByRole("alert")).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "Confirm share order" }),
    ).toHaveCount(0);
    await expect(input).toHaveValue("1");
    await page.getByRole("button", { name: "Quote order" }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm share order" }),
    ).toBeVisible();
    await expect.poll(() => reviewedQuotes()).toHaveLength(2);
    const replacementQuote = reviewedQuotes()[1]!;
    expect(replacementQuote.idempotencyKey).toEqual(expect.any(String));
    expect(replacementQuote.idempotencyKey).not.toBe(originalQuote.idempotencyKey);
    await expect(
      page.getByText(
        /Issue 1 shares to Quoted Member/,
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Locked price: \$1.00 per share/,
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm order" }).click();
    await expect.poll(() => reviewedExecutions()).toHaveLength(2);
    const confirmedExecution = reviewedExecutions()[1]!;
    expect(confirmedExecution.idempotencyKey).toEqual(expect.any(String));
    expect(confirmedExecution.idempotencyKey).not.toBe(rejectedExecution.idempotencyKey);
    expect(confirmedExecution.idempotencyKey).not.toBe(replacementQuote.idempotencyKey);
    await expect(page).toHaveURL(/\/p\/stale-order-pool\/overview$/);
    await page.getByRole("link", { name: "Share orders" }).click();
    await page.getByLabel("Member").selectOption({ label: "Quoted Member" });
  }
});

test("Admin Orders gives distinct no-active and draft-season recovery guidance", async ({
  page,
  worker,
}) => {
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Season Recovery Pool");
  await page.getByLabel("Pool web address").fill("season-recovery-pool");
  await page.getByLabel("Join password").fill("season-recovery-password");
  await page.getByRole("button", { name: "Create pool" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await expect(page.getByRole("status")).toContainText(
    "No active season. Create and open a season before issuing orders.",
  );
  await page.goto(`${worker.baseURL}/p/season-recovery-pool/admin/season`);
  await page.getByLabel("Season label").fill("2026");
  await page.getByRole("button", { name: "Create season" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await expect(page.getByRole("status")).toContainText(
    "A draft season exists. Open it from Season administration before issuing orders.",
  );
});

test("season recovery states block order quotes and direct the commissioner to the permitted next step", async ({
  page,
  worker,
}) => {
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Closed Recovery Pool");
  await page.getByLabel("Pool web address").fill("closed-recovery-pool");
  await page.getByLabel("Join password").fill("closed-recovery-password");
  await page.getByRole("button", { name: "Create pool" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  let quotePosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/admin/orders/quote")
    )
      quotePosts++;
  });
  await expect(page.getByRole("status")).toContainText(
    "No active season. Create and open a season before issuing orders.",
  );
  await expect(
    page.getByRole("button", { name: "Quote order" }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Season", exact: true }).click();
  await page.getByLabel("Season label").fill("2026");
  await page.getByLabel("Default amount").fill("1");
  await page.getByRole("button", { name: "Create season" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await expect(page.getByRole("status")).toContainText(
    "A draft season exists. Open it from Season administration before issuing orders.",
  );
  await expect(
    page.getByRole("button", { name: "Quote order" }),
  ).toBeDisabled();
  await expect.poll(() => quotePosts).toBe(0);
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Season", exact: true }).click();
  await page.getByRole("button", { name: "Open season" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await expect(page.getByLabel("Amount")).toHaveValue("1");
  await page.getByRole("button", { name: "Quote order" }).click();
  await page.getByRole("button", { name: "Confirm order" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  const closed = await page.evaluate(
    async () =>
      (
        await fetch("/__local-test/season", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            poolSlug: "closed-recovery-pool",
            state: "closed",
          }),
        })
      ).status,
  );
  expect(closed).toBe(200);
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await expect(page.getByRole("status")).toContainText(
    "This season is closed. Review immutable order history; create and open a new season before issuing orders.",
  );
  await expect(
    page.getByRole("button", { name: "Quote order" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Reverse with reason" }),
  ).toHaveCount(0);
  await expect(page.getByText("Read-only closed-season record")).toBeVisible();
  await expect.poll(() => quotePosts).toBe(1);
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Season", exact: true }).click();
  await page.getByLabel("Season label").fill("2027");
  await page.getByLabel("Default amount").fill("1");
  await page.getByRole("button", { name: "Create season" }).click();
  await page.getByRole("button", { name: "Open season" }).click();
  await page.getByRole("link", { name: "Pool home" }).click();
  await page.getByRole("link", { name: "Share orders" }).click();
  await expect(page.getByLabel("Amount")).toHaveValue("1");
  await page.getByRole("button", { name: "Quote order" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm share order" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm order" }).click();
  await expect(page).toHaveURL(/\/p\/closed-recovery-pool\/overview$/);
});

test("real auth and PoolDO reject noncommissioner order controls, stale reversal auth, and semantic idempotency conflicts", async ({
  page,
  browser,
  worker,
}) => {
  const slug = "authz-idempotency-pool";
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Authorization Pool");
  await page.getByLabel("Pool web address").fill(slug);
  await page.getByLabel("Join password").fill("authorization-password");
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

  const ownerState = await page.evaluate(async (poolSlug) => {
    const view = (await (await fetch(`/api/p/${poolSlug}/view`)).json()) as {
      activeSeason: { id: string } | null;
      currentMember: {
        memberId: string;
        seasonBalances: Array<{ seasonId: string; availableMicros: string }>;
      };
      commissioner: {
        seasonOrders: Array<{
          seasonId: string;
          orders: Array<{ orderId: string }>;
        }>;
      } | null;
    };
    if (!view.activeSeason || !view.commissioner)
      throw new Error("Expected active commissioner view");
    const activeOrders = view.commissioner.seasonOrders.find(
      (set) => set.seasonId === view.activeSeason!.id,
    )?.orders;
    if (!activeOrders?.length) throw new Error("Expected active-season orders");
    const activeBalance = view.currentMember.seasonBalances.find(
      (balance) => balance.seasonId === view.activeSeason!.id,
    );
    if (!activeBalance) throw new Error("Expected active-season balance");
    return {
      seasonId: view.activeSeason.id,
      memberId: view.currentMember.memberId,
      orderId: activeOrders[0]!.orderId,
      availableMicros: activeBalance.availableMicros,
      orderCount: activeOrders.length,
    };
  }, slug);
  const conflict = await page.evaluate(
    async ({ poolSlug, seasonId, memberId }) => {
      const quote = (await (
        await fetch(`/api/p/${poolSlug}/admin/orders/quote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            seasonId,
            memberId,
            mode: "shares",
            amountMicros: "1000000",
            idempotencyKey: crypto.randomUUID(),
          }),
        })
      ).json()) as { priceMicros: string; commandVersion: string };
      const request = {
        seasonId,
        memberId,
        mode: "shares",
        amountMicros: "1000000",
        quote: {
          priceMicros: quote.priceMicros,
          commandVersion: quote.commandVersion,
        },
        reason: "One immutable issue",
        idempotencyKey: "semantic-conflict-key",
      };
      const first = await fetch(`/api/p/${poolSlug}/admin/orders/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const before = await (await fetch(`/api/p/${poolSlug}/view`)).json();
      const second = await fetch(`/api/p/${poolSlug}/admin/orders/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          amountMicros: "2000000",
          reason: "Different semantic input",
        }),
      });
      const after = await (await fetch(`/api/p/${poolSlug}/view`)).json();
      const activeBefore = before.activeSeason as { id: string } | null;
      const activeAfter = after.activeSeason as { id: string } | null;
      if (
        !activeBefore ||
        !activeAfter ||
        !before.commissioner ||
        !after.commissioner
      )
        throw new Error("Expected active commissioner views");
      const balance = (view: typeof before, seasonId: string) =>
        (
          view.currentMember.seasonBalances as Array<{
            seasonId: string;
            availableMicros: string;
          }>
        ).find((entry) => entry.seasonId === seasonId)?.availableMicros;
      const orders = (view: typeof before, seasonId: string) =>
        (
          view.commissioner.seasonOrders as Array<{
            seasonId: string;
            orders: unknown[];
          }>
        ).find((entry) => entry.seasonId === seasonId)?.orders.length;
      return {
        first: first.status,
        second: { status: second.status, body: await second.json() },
        before: {
          available: balance(before, activeBefore.id),
          orders: orders(before, activeBefore.id),
        },
        after: {
          available: balance(after, activeAfter.id),
          orders: orders(after, activeAfter.id),
        },
      };
    },
    {
      poolSlug: slug,
      seasonId: ownerState.seasonId,
      memberId: ownerState.memberId,
    },
  );
  expect(conflict.first).toBe(200);
  expect(conflict.second).toEqual({
    status: 400,
    body: { code: "IDEMPOTENCY_CONFLICT" },
  });
  expect(conflict.after).toEqual(conflict.before);

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await member.goto(`${worker.baseURL}/sign-up`);
    await member.getByLabel("Name").fill("Noncommissioner Member");
    await member
      .getByLabel("Email address")
      .fill("noncommissioner@example.test");
    await member.getByLabel("Password").fill("first-password");
    await member.getByRole("button", { name: "Create account" }).click();
    await member.getByRole("link", { name: "log in", exact: true }).click();
    await member
      .getByLabel("Email address")
      .fill("noncommissioner@example.test");
    await member.getByLabel("Password").fill("first-password");
    await member.getByRole("button", { name: "Log in" }).click();
    await expect(member).toHaveURL(`${worker.baseURL}/`);
    await expect(member.getByRole("heading", { name: "Your pools" })).toBeVisible();
    await member.goto(`${worker.baseURL}/p/${slug}`);
    await member.getByLabel("Pool password").fill("authorization-password");
    await member.getByRole("button", { name: "Join pool" }).click();
    await member.goto(`${worker.baseURL}/p/${slug}/admin/orders`);
    await expect(member.getByRole("alert")).toHaveText(
      "Only the commissioner can issue or reverse virtual share orders.",
    );
    await expect(
      member.getByRole("button", { name: /Quote order|Reverse with reason/ }),
    ).toHaveCount(0);
    const denied = await member.evaluate(
      async ({ poolSlug, seasonId, memberId, orderId }) =>
        Promise.all([
          fetch(`/api/p/${poolSlug}/admin/orders/quote`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              seasonId,
              memberId,
              mode: "shares",
              amountMicros: "1000000",
              idempotencyKey: crypto.randomUUID(),
            }),
          }),
          fetch(`/api/p/${poolSlug}/admin/orders/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              seasonId,
              memberId,
              mode: "shares",
              amountMicros: "1000000",
              quote: { priceMicros: "1000000", commandVersion: "1" },
              reason: "Unauthorized issue",
              idempotencyKey: crypto.randomUUID(),
            }),
          }),
          fetch(`/api/p/${poolSlug}/admin/orders/${orderId}/reverse`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              reason: "Unauthorized reversal",
              idempotencyKey: crypto.randomUUID(),
            }),
          }),
        ]).then(async (responses) =>
          Promise.all(
            responses.map(async (response) => ({
              status: response.status,
              body: await response.json(),
            })),
          ),
        ),
      {
        poolSlug: slug,
        seasonId: ownerState.seasonId,
        memberId: ownerState.memberId,
        orderId: ownerState.orderId,
      },
    );
    expect(denied).toEqual([
      { status: 403, body: { code: "FORBIDDEN" } },
      { status: 403, body: { code: "FORBIDDEN" } },
      { status: 403, body: { code: "FORBIDDEN" } },
    ]);
  } finally {
    await memberContext.close();
  }

  const expired = await page.evaluate(
    async (userId) =>
      await (
        await fetch("/__local-test/expire-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId }),
        })
      ).json(),
    ownerState.memberId,
  );
  expect(expired).toEqual({ expired: true });
  const staleReversal = await page.evaluate(
    async ({ poolSlug, orderId }) => {
      const response = await fetch(
        `/api/p/${poolSlug}/admin/orders/${orderId}/reverse`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reason: "Fresh authentication required",
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { poolSlug: slug, orderId: ownerState.orderId },
  );
  expect(staleReversal).toEqual({
    status: 403,
    body: { code: "RECENT_AUTH_REQUIRED" },
  });
  const pageErrors: string[] = [];
  const reversalBodies: Record<string, unknown>[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/admin/orders/") &&
      request.url().endsWith("/reverse")
    )
      reversalBodies.push(request.postDataJSON() as Record<string, unknown>);
  });
  await page.goto(`${worker.baseURL}/p/${slug}/admin/orders`);
  await page
    .getByRole("button", { name: "Reverse with reason" })
    .first()
    .click();
  await page.getByLabel("Reason").fill("Requires a fresh sign-in");
  await page.getByRole("button", { name: "Confirm reversal" }).click();
  await expect(page.getByRole("alert")).toHaveText("Sign in again.");
  await expect(
    page.getByRole("heading", { name: "Confirm share-order reversal" }),
  ).toBeVisible();
  await expect(page.getByLabel("Reason")).toHaveValue(
    "Requires a fresh sign-in",
  );
  await page.getByRole("button", { name: "Confirm reversal" }).click();
  await expect.poll(() => reversalBodies).toHaveLength(2);
  expect(reversalBodies[1]).toEqual(reversalBodies[0]);
  await expect.poll(() => pageErrors).toEqual([]);
});

test("stale and locked quoted offers reject only that new wager with a focused error and preserve the balance", async ({
  page,
  worker,
}) => {
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Offer Recovery Pool");
  await page.getByLabel("Pool web address").fill("offer-recovery-pool");
  await page.getByLabel("Join password").fill("offer-recovery-password");
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
  await expect(page).toHaveURL(/\/overview$/);
  await page.getByRole("link", { name: "Odds board", exact: true }).click();

  for (const state of ["stale", "locked"] as const) {
    await page.getByRole("checkbox", { name: /^Local Away [+-]?\d+(\.\d+)?$/ }).check();
    await page.getByLabel(/^Risk in whole shares for .*: spread/).fill("1");
    await page.getByRole("button", { name: "Place bets" }).click();
    await expect(
      page.getByRole("heading", { name: "Review straight wagers" }),
    ).toBeVisible();
    const transition = await page.evaluate(
      async (nextState) =>
        (
          await fetch("/__local-test/offer-state", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              eventId: "local-nfl-upcoming",
              market: "spread",
              state: nextState,
            }),
          })
        ).status,
      state,
    );
    expect(transition).toBe(200);
    await page.getByRole("button", { name: "Place 1 wager" }).click();
    const error = page.getByRole("alert");
    await expect(error).toContainText(
      state === "stale"
        ? "Odds are stale."
        : "Event has started.",
    );
    await expect(
      page.getByRole("heading", { name: "Placement results" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back to odds board" }).click();
    await expect(page.getByLabel(/^Risk in whole shares for/)).toHaveValue("1");
    await page.goto(`${worker.baseURL}/p/offer-recovery-pool/overview`);
    await expect(
      page.getByRole("row", { name: /Available shares/i }),
    ).toContainText("3.00");
    if (state === "stale") {
      const restored = await page.evaluate(
        async () =>
          (
            await fetch("/__local-test/offer-state", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                eventId: "local-nfl-upcoming",
                market: "spread",
                state: "current",
              }),
            })
          ).status,
      );
      expect(restored).toBe(200);
      await page.getByRole("link", { name: "Odds board", exact: true }).click();
    }
  }
});
