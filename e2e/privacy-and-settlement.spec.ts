import { test, expect } from "./fixtures/local-worker";
import type { Page } from "@playwright/test";

type Mailbox = () => Promise<Array<{ kind: "verification" | "password-reset"; to: string; token: string }>>;

/** Signs up, verifies through the development mailbox, and signs in — awaiting the completed session transition. */
async function signInAccount(page: Page, baseURL: string, mailbox: Mailbox, name: string, email: string) {
  // The fixture uses random loopback ports; discard a cookie from a reused port before real sign-up.
  await page.context().clearCookies();
  await page.goto(`${baseURL}/sign-up`);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect.poll(async () => (await mailbox()).find((message) => message.to === email)?.token).toBeTruthy();
  const token = (await mailbox()).find((message) => message.to === email)!.token;
  await page.evaluate(async (value) => { await fetch(`/api/auth/verify-email?token=${encodeURIComponent(value)}`); }, token);
  await page.getByRole("link", { name: "log in", exact: true }).click();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Log in" }).click();
  // Do not race the redirect: wait for the authenticated home before continuing the journey.
  await expect(page.getByRole("heading", { name: "Your pools" })).toBeVisible();
}

async function signIn(page: Page, baseURL: string, mailbox: Mailbox, name = "T11 Commissioner", email = "t11-commissioner@example.test") {
  await signInAccount(page, baseURL, mailbox, name, email);
}

async function createPool(page: Page, baseURL: string, slug: string, poolName: string, password: string) {
  await page.goto(`${baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill(poolName);
  await page.getByLabel("Pool web address").fill(slug);
  await page.getByLabel("Join password").fill(password);
  await page.getByRole("button", { name: "Create pool" }).click();
  await expect(page.getByRole("link", { name: "Standings", exact: true })).toBeVisible();
}

async function openSeason(page: Page, baseURL: string, slug: string, label: string) {
  await page.getByRole("link", { name: "Season", exact: true }).click();
  await page.getByLabel("Season label").fill(label);
  await page.getByRole("button", { name: "Create season" }).click();
  await page.getByRole("button", { name: "Open season" }).click();
  await page.getByRole("link", { name: "Pool overview" }).click();
}

async function issueShares(page: Page, baseURL: string, slug: string, shares: string, memberName?: string) {
  await page.goto(`${baseURL}/p/${slug}/admin/orders`);
  if (memberName) await page.getByLabel("Member").selectOption({ label: memberName });
  await page.getByLabel("Amount").fill(shares);
  await page.getByRole("button", { name: "Quote order" }).click();
  await page.getByRole("button", { name: "Confirm order" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${slug}/overview$`));
}

/** Joins through the real password gate and awaits the authoritative member redirect. */
async function joinPool(page: Page, baseURL: string, slug: string, password: string) {
  await page.goto(`${baseURL}/p/${slug}`);
  await page.getByLabel("Pool password").fill(password);
  await page.getByRole("button", { name: "Join pool" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${slug}/overview$`));
}

async function placeAwaySpreadWager(page: Page, baseURL: string, slug: string, risk = "1") {
  await page.goto(`${baseURL}/p/${slug}/odds`);
  await page.getByRole("button", { name: "Select Local Away 3", exact: true }).click();
  await page.getByLabel("Risk in whole shares").fill(risk);
  await page.getByRole("button", { name: "Review straight wager" }).click();
  await page.getByRole("button", { name: "Place wager" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${slug}/my-wagers$`));
}

/** Documented loopback fixture controls only: canonical fixture reseed, final results, alarms, and lifecycle close. */
const controlStatus = (page: Page, path: string, body: unknown) => page.evaluate(async ({ path, body }) => (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, { path, body } as { path: string; body: unknown });
/** The seeded upcoming event's start and offer retrieval are refreshed so every placement window is deterministic. */
const reseedUpcomingEvent = async (page: Page) => { expect(await controlStatus(page, "/__local-test/seed", {})).toBe(200); };

async function settleFixtureResult(page: Page, poolSlug: string, homeScore: number, awayScore: number) {
  const currentTime = new Date(Date.now() + 10 * 60_000).toISOString();
  expect(await controlStatus(page, "/__local-test/result", { eventId: "local-nfl-upcoming", homeScore, awayScore })).toBe(200);
  expect(await controlStatus(page, "/__local-test/alarm", { poolSlug, currentTime })).toBe(200);
  expect(await controlStatus(page, "/__local-test/current-time", { poolSlug, currentTime })).toBe(200);
}

const lastWagerId = async (page: Page, poolSlug: string) => page.evaluate(async (slug) => {
  const body = await (await fetch(`/api/p/${slug}/wagers`)).json() as { wagers: Array<{ wagerId: string }> };
  return body.wagers[body.wagers.length - 1]!.wagerId;
}, poolSlug);

/** Real commissioner corrections over the authenticated Worker route; regrades use only rendered PoolDO-authorized event evidence. */
async function correctWager(page: Page, poolSlug: string, wagerId: string, outcome: "won" | "lost" | "refunded", reason: string, correctionVersion: string) {
  let renderedEvidence: { eventId: string; league: string } | undefined;
  if (outcome !== "refunded") {
    await page.goto(`${new URL(page.url()).origin}/p/${poolSlug}/admin/corrections`);
    const row = page.getByRole("table", { name: "Eligible active-season wagers" }).locator("tbody tr").filter({ hasText: /nfl|ncaaf/ }).first();
    const cells = row.locator("th, td");
    renderedEvidence = { eventId: (await cells.nth(3).innerText()).trim(), league: (await cells.nth(4).innerText()).trim() };
    expect(renderedEvidence.eventId).toBeTruthy();
    expect(renderedEvidence.league).toMatch(/^(nfl|ncaaf)$/);
  }
  return page.evaluate(async ({ poolSlug, wagerId, outcome, reason, correctionVersion, renderedEvidence }) => {
    const path = outcome === "refunded" ? `/api/p/${poolSlug}/admin/corrections/${wagerId}/void` : `/api/p/${poolSlug}/admin/corrections/${wagerId}/regrade`;
    const correctedResults = renderedEvidence ? [{ ...renderedEvidence, status: "final", homeScore: outcome === "won" ? 17 : 24, awayScore: outcome === "won" ? 24 : 17, correctionVersion }] : undefined;
    const body = outcome === "refunded" ? { idempotencyKey: crypto.randomUUID(), reason } : { idempotencyKey: crypto.randomUUID(), reason, correctedResults };
    return (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  }, { poolSlug, wagerId, outcome, reason, correctionVersion, renderedEvidence });
}

const activityJson = (page: Page, poolSlug: string) => page.evaluate(async (slug) => JSON.stringify(await (await fetch(`/api/p/${slug}/activity`)).json()), poolSlug);

/** Re-authenticates an existing account through the real Better Auth login form, restoring recent auth. */
async function logInAgain(page: Page, baseURL: string, email: string) {
  await page.context().clearCookies();
  await page.goto(`${baseURL}/login`);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Your pools" })).toBeVisible();
}

/** The signed-in account's real Better Auth user id (the PoolDO member key). */
const sessionUserId = (page: Page) => page.evaluate(async () => ((await (await fetch("/api/auth/get-session")).json()) as { user?: { id?: string } }).user?.id ?? "");
/** Makes the account's real sessions older than the production recent-auth window. */
const expireRecentAuth = (page: Page, userId: string) => controlStatus(page, "/__local-test/expire-session", { userId });
/** Real boundary probe of a transfer command; denied commands never write. */
const transferStatus = (page: Page, poolSlug: string, memberId: string, reason: string) => page.evaluate(async ({ poolSlug, memberId, reason }) => {
  const response = await fetch(`/api/p/${poolSlug}/admin/transfer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId, reason, idempotencyKey: crypto.randomUUID() }) });
  return { status: response.status, code: (await response.json() as { code: string }).code };
}, { poolSlug, memberId, reason } as { poolSlug: string; memberId: string; reason: string });

async function standingsRowTexts(page: Page, displayName: string) {
  const row = page.getByRole("row", { name: new RegExp(displayName) });
  await expect(row).toBeVisible();
  return (await row.locator("td, th").allInnerTexts()).map((text) => text.trim());
}

test("member navigation reaches real standings, activity, rules, history, and constrained administration", async ({ page, worker }) => {
  const slug = "t11-member-views";
  await signIn(page, worker.baseURL, worker.mailbox);
  await createPool(page, worker.baseURL, slug, "T11 Member Views", "member-views-password");
  await page.getByRole("link", { name: "Standings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Standings" })).toBeVisible();
  await page.goto(`${worker.baseURL}/p/${slug}/activity`);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await page.goto(`${worker.baseURL}/p/${slug}/rules`);
  await expect(page.getByRole("heading", { name: "Pool rules" })).toBeVisible();
  await page.goto(`${worker.baseURL}/p/${slug}/admin/members`);
  await expect(page.getByRole("heading", { name: "Member administration" })).toBeVisible();
});

test("rules page reports authoritative season and exact stored feed/source observations", async ({ page, worker }) => {
  const slug = "t11-rules-feed";
  await signIn(page, worker.baseURL, worker.mailbox, "Rules Commissioner", "rules-commissioner@example.test");
  await createPool(page, worker.baseURL, slug, "Rules Feed Pool", "rules-feed-password");
  await page.goto(`${worker.baseURL}/p/${slug}/rules`);
  await expect(page.getByText("No active or closed season is available", { exact: false })).toBeVisible();

  await page.goto(`${worker.baseURL}/p/${slug}/overview`);
  await openSeason(page, worker.baseURL, slug, "Active 2026");
  const observation = { lastPolledAt: "2030-09-01T10:03:00.000Z", lastSuccessAt: "2030-09-01T10:02:00.000Z", retrievedAt: "2030-09-01T10:00:00.000Z" };
  expect(await controlStatus(page, "/__local-test/feed-state", { state: "current", ...observation })).toBe(200);
  await page.goto(`${worker.baseURL}/p/${slug}/rules`);
  await expect(page.getByRole("row", { name: /Season Active 2026/ })).toBeVisible();
  await expect(page.getByRole("row", { name: "State active" })).toBeVisible();
  await expect(page.getByRole("row", { name: "Ruleset SHARE_POOL_2026_V1" })).toBeVisible();
  await expect(page.getByRole("row", { name: "State current" })).toBeVisible();
  await expect(page.getByRole("row", { name: `Last polled ${observation.lastPolledAt}` })).toBeVisible();
  await expect(page.getByRole("row", { name: /Local Away at Local Home spread DraftKings 2030-09-01T10:00:00.000Z/ })).toBeVisible();

  expect(await controlStatus(page, "/__local-test/feed-state", { state: "stale", ...observation, lastPolledAt: "2030-09-01T10:04:00.000Z" })).toBe(200);
  await page.reload();
  await expect(page.getByRole("row", { name: "State stale" })).toBeVisible();
  await expect(page.getByText("No current canonical offer source observations are available.")).toBeVisible();

  expect(await controlStatus(page, "/__local-test/feed-state", { state: "provider-error", ...observation, lastPolledAt: "2030-09-01T10:05:00.000Z", lastSuccessAt: "2030-09-01T09:58:00.000Z" })).toBe(200);
  await page.reload();
  await expect(page.getByRole("row", { name: "State provider-error" })).toBeVisible();
  await expect(page.getByRole("row", { name: "Last successful poll 2030-09-01T09:58:00.000Z" })).toBeVisible();
  await expect(page.getByText("No current canonical offer source observations are available.")).toBeVisible();

  expect(await controlStatus(page, "/__local-test/feed-state", { state: "no-offer", ...observation, lastPolledAt: "2030-09-01T10:06:00.000Z" })).toBe(200);
  expect(await controlStatus(page, "/__local-test/season", { poolSlug: slug, state: "closed" })).toBe(200);
  await page.reload();
  await expect(page.getByRole("row", { name: "Season Active 2026" })).toBeVisible();
  await expect(page.getByRole("row", { name: "State closed" })).toBeVisible();
  await expect(page.getByRole("row", { name: "State no-offer" })).toBeVisible();
});

test("an ordinary member has no administration or hidden-pick privilege at navigation, page, or HTTP boundaries", async ({ page, browser, worker }) => {
  const slug = "t11-member-denial";
  await worker.resetAuthLimiter();
  await signIn(page, worker.baseURL, worker.mailbox, "T11 Denial Commissioner", "t11-denial-commissioner@example.test");
  await createPool(page, worker.baseURL, slug, "T11 Denial", "member-views-password");
  await openSeason(page, worker.baseURL, slug, "2025");
  expect(await controlStatus(page, "/__local-test/season", { poolSlug: slug, state: "closed" })).toBe(200);
  await page.goto(`${worker.baseURL}/p/${slug}/overview`);
  await openSeason(page, worker.baseURL, slug, "2026");
  const ownerView = await page.evaluate(async (poolSlug) => await (await fetch(`/api/p/${poolSlug}/view`)).json() as { activeSeason: { id: string }; latestClosedSeason: { id: string }; currentMember: { memberId: string } }, slug);
  const context = await browser.newContext(); const member = await context.newPage();
  const ticketContext = await browser.newContext(); const ticketOwner = await ticketContext.newPage();
  try {
    await worker.resetAuthLimiter();
    await signIn(ticketOwner, worker.baseURL, worker.mailbox, "T11 Denial Ticket Owner", "t11-denial-ticket-owner@example.test");
    await joinPool(ticketOwner, worker.baseURL, slug, "member-views-password");
    await issueShares(page, worker.baseURL, slug, "2", "T11 Denial Ticket Owner");
    await reseedUpcomingEvent(ticketOwner);
    await placeAwaySpreadWager(ticketOwner, worker.baseURL, slug);
    const wagerId = await lastWagerId(ticketOwner, slug);
    await worker.resetAuthLimiter();
    await signIn(member, worker.baseURL, worker.mailbox, "T11 Denial Member", "t11-denial-member@example.test");
    await joinPool(member, worker.baseURL, slug, "member-views-password");
    await member.goto(`${worker.baseURL}/p/${slug}/overview`);
    for (const name of ["Season", "Share orders", "Members", "Corrections", "Settings"]) await expect(member.getByRole("link", { name, exact: true })).toHaveCount(0);

    const deniedPages: Array<[string, string]> = [
      ["members", "Only the commissioner can manage members."],
      ["orders", "Only the commissioner can issue or reverse virtual share orders."],
      ["corrections", "Only the commissioner can correct eligible active-season wagers."],
      ["settings", "Only the commissioner can change pool settings."],
      ["season", "Only the commissioner can create or open a season."]
    ];
    for (const [path, notice] of deniedPages) {
      await member.goto(`${worker.baseURL}/p/${slug}/admin/${path}`);
      await expect(member.getByRole("alert")).toHaveText(notice);
      await expect(member.getByRole("main").getByRole("button")).toHaveCount(0);
    }
    // Closed history stays readable, but the embedded commissioner annotation control is absent.
    await member.goto(`${worker.baseURL}/p/${slug}/history/${ownerView.latestClosedSeason.id}`);
    await expect(member.getByRole("heading", { name: "Archived season: 2025" })).toBeVisible();
    await expect(member.getByLabel("Add annotation")).toHaveCount(0);
    await expect(member.getByRole("main").getByRole("button")).toHaveCount(0);

    const memberId = await sessionUserId(member);
    const probes = [
      { name: "members", path: `/admin/members/${ownerView.currentMember.memberId}/suspend`, body: { idempotencyKey: crypto.randomUUID() } },
      { name: "orders", path: "/admin/orders/quote", body: { seasonId: ownerView.activeSeason.id, memberId, mode: "shares", amountMicros: "1000000", idempotencyKey: crypto.randomUUID() } },
      { name: "corrections", path: `/admin/corrections/${wagerId}/void`, body: { reason: "Member attempt", idempotencyKey: crypto.randomUUID() } },
      { name: "settings", path: "/admin/settings", body: { poolName: "No", idempotencyKey: crypto.randomUUID() } },
      { name: "season", path: "/admin/seasons", body: { seasonId: crypto.randomUUID(), label: "Never", idempotencyKey: crypto.randomUUID() } },
      { name: "history annotation", path: `/admin/history/${ownerView.activeSeason.id}/annotations`, body: { text: "Member attempt", idempotencyKey: crypto.randomUUID() } },
      { name: "transfer", path: "/admin/transfer", body: { memberId, reason: "Member attempt", idempotencyKey: crypto.randomUUID() } },
      { name: "Super Bowl confirmation", path: `/admin/seasons/${ownerView.activeSeason.id}/super-bowl/confirm`, body: { eventId: "local-nfl-upcoming", idempotencyKey: crypto.randomUUID() } }
    ];
    for (const probe of probes) {
      const denied = await member.evaluate(async ({ poolSlug, probe }) => { const response = await fetch(`/api/p/${poolSlug}${probe.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(probe.body) }); return { status: response.status, code: (await response.json() as { code: string }).code }; }, { poolSlug: slug, probe });
      expect(denied, probe.name).toEqual({ status: 403, code: "FORBIDDEN" });
    }

    // A commissioner is still a nonowner: neither account may discover this member-owned ticket before kickoff.
    const hiddenMember = await activityJson(member, slug);
    const hiddenCommissioner = await activityJson(page, slug);
    expect(hiddenMember).toBe(hiddenCommissioner);
    for (const protectedText of ["Local Away", "Local Home", "riskMicros", "selection", "originalLine"]) expect(hiddenMember).not.toContain(protectedText);
  } finally { await context.close(); await ticketContext.close(); }
});

test("canonical Super Bowl confirmation and final result automatically close the season", async ({ page, browser, worker }) => {
  test.setTimeout(480_000);
  const slug = "t11-super-bowl";
  await worker.resetAuthLimiter();
  await signInAccount(page, worker.baseURL, worker.mailbox, "T11 Super Commissioner", "t11-super-commissioner@example.test");
  await createPool(page, worker.baseURL, slug, "T11 Super Bowl", "super-bowl-password");
  await openSeason(page, worker.baseURL, slug, "2026");

  const ownerContext = await browser.newContext(); const owner = await ownerContext.newPage();
  const memberContext = await browser.newContext(); const member = await memberContext.newPage();
  try {
    await worker.resetAuthLimiter();
    await signInAccount(owner, worker.baseURL, worker.mailbox, "T11 Super Ticket Owner", "t11-super-owner@example.test");
    await joinPool(owner, worker.baseURL, slug, "super-bowl-password");
    await worker.resetAuthLimiter();
    await signInAccount(member, worker.baseURL, worker.mailbox, "T11 Super Member", "t11-super-member@example.test");
    await joinPool(member, worker.baseURL, slug, "super-bowl-password");
    await issueShares(page, worker.baseURL, slug, "2", "T11 Super Ticket Owner");

    await reseedUpcomingEvent(owner);
    await owner.goto(`${worker.baseURL}/p/${slug}/odds`);
    await owner.getByRole("button", { name: "Select Local Away 3", exact: true }).click();
    await owner.getByLabel("Risk in whole shares").fill("1");
    await owner.getByRole("button", { name: "Review straight wager" }).click();
    await owner.getByRole("button", { name: "Place wager" }).click();
    await expect(owner).toHaveURL(new RegExp(`/p/${slug}/my-wagers$`));

    const initialView = await page.evaluate(async (poolSlug) => await (await fetch(`/api/p/${poolSlug}/view`)).json() as { activeSeason: { id: string } }, slug);
    const seasonId = initialView.activeSeason.id;
    const candidateAlarmTime = new Date(Date.now() + 10 * 60_000);
    expect(await controlStatus(page, "/__local-test/alarm", { poolSlug: slug, currentTime: candidateAlarmTime.toISOString() })).toBe(200);

    await page.goto(`${worker.baseURL}/p/${slug}/admin/season`);
    await expect(page.getByText("Canonical Super Bowl candidate: T11 Local Super Bowl LXI.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm canonical Super Bowl" })).toBeVisible();

    const confirmProbe = (actor: Page, eventId: string) => actor.evaluate(async ({ poolSlug, seasonId, eventId }) => {
      const response = await fetch(`/api/p/${poolSlug}/admin/seasons/${seasonId}/super-bowl/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId, idempotencyKey: crypto.randomUUID() }) });
      return { status: response.status, code: (await response.json() as { code?: string }).code };
    }, { poolSlug: slug, seasonId, eventId });
    expect(await confirmProbe(member, "local-nfl-super-bowl")).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(await confirmProbe(page, "local-nfl-upcoming")).toEqual({ status: 400, code: "SUPER_BOWL_NOT_CANONICAL" });

    // The commissioner is a nonowner too: both authorized nonowners receive the same server-redacted bytes.
    const commissionerHidden = await activityJson(page, slug);
    const memberHidden = await activityJson(member, slug);
    expect(commissionerHidden).toBe(memberHidden);
    for (const protectedText of ["Local Away", "Local Home", "riskMicros", "selection", "originalLine"]) expect(commissionerHidden).not.toContain(protectedText);

    const confirmationBodies: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (request.url().endsWith(`/api/p/${slug}/admin/seasons/${seasonId}/super-bowl/confirm`)) confirmationBodies.push(request.postDataJSON() as Record<string, unknown>);
    });
    const beforeConfirmation = await page.evaluate(async (poolSlug) => await (await fetch(`/api/p/${poolSlug}/view`)).json() as { commandVersion: string }, slug);
    expect(await page.evaluate(async (pathname) => (await fetch("/__local-test/response-barrier", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "drop", pathname }) })).status, `/api/p/${slug}/admin/seasons/${seasonId}/super-bowl/confirm`)).toBe(200);
    const droppedConfirmationAt = Date.now();
    await page.getByRole("button", { name: "Confirm canonical Super Bowl" }).click();
    await expect(page.getByRole("alert")).toContainText("Unable to complete this request (REQUEST_FAILED).");
    expect(Date.now() - droppedConfirmationAt).toBeLessThan(10_000);
    await page.getByRole("button", { name: "Confirm canonical Super Bowl" }).click();
    await expect(page.getByText(/Canonical Super Bowl candidate: T11 Local Super Bowl LXI\. Confirmed\./)).toBeVisible();
    expect(confirmationBodies).toHaveLength(2);
    expect(confirmationBodies[1]).toEqual(confirmationBodies[0]);
    const afterConfirmation = await page.evaluate(async (poolSlug) => await (await fetch(`/api/p/${poolSlug}/view`)).json() as { commandVersion: string }, slug);
    expect(Number(afterConfirmation.commandVersion)).toBe(Number(beforeConfirmation.commandVersion) + 1);
    const manualClose = await page.evaluate(async ({ poolSlug, seasonId }) => (await fetch(`/api/p/${poolSlug}/admin/seasons/${seasonId}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "manual", idempotencyKey: crypto.randomUUID() }) })).status, { poolSlug: slug, seasonId });
    expect(manualClose).toBe(404);

    expect(await controlStatus(page, "/__local-test/result", { eventId: "local-nfl-super-bowl", homeScore: 27, awayScore: 24 })).toBe(200);
    expect(await controlStatus(page, "/__local-test/alarm", { poolSlug: slug, currentTime: new Date(candidateAlarmTime.getTime() + 3 * 60_000).toISOString() })).toBe(200);
    const delayed = await page.evaluate(async (poolSlug) => await (await fetch(`/api/p/${poolSlug}/view`)).json() as { activeSeason: { id: string } }, slug);
    expect(delayed.activeSeason).toMatchObject({ id: seasonId });

    expect(await controlStatus(page, "/__local-test/result", { eventId: "local-nfl-upcoming", homeScore: 24, awayScore: 17 })).toBe(200);
    expect(await controlStatus(page, "/__local-test/alarm", { poolSlug: slug, currentTime: new Date(candidateAlarmTime.getTime() + 5 * 60_000).toISOString() })).toBe(200);
    const closed = await page.evaluate(async (poolSlug) => await (await fetch(`/api/p/${poolSlug}/view`)).json() as { activeSeason: null; latestClosedSeason: { id: string; closeReason: string } }, slug);
    expect(closed.activeSeason).toBeNull();
    expect(closed.latestClosedSeason).toMatchObject({ id: seasonId, closeReason: "super_bowl_final" });
    const reopen = await page.evaluate(async ({ poolSlug, seasonId }) => { const response = await fetch(`/api/p/${poolSlug}/admin/seasons/${seasonId}/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) }); return { status: response.status, code: (await response.json() as { code: string }).code }; }, { poolSlug: slug, seasonId });
    expect(reopen).toEqual({ status: 400, code: "SEASON_NOT_DRAFT" });
  } finally { await ownerContext.close(); await memberContext.close(); }
});

test("standings display canonical fixed-point values that change after real settlement and after regrade", async ({ page, browser, worker }) => {
  const slug = "t11r3a-standings";
  const ownerName = "T11R3A Commissioner";
  const memberName = "T11R3A Member";
  await worker.resetAuthLimiter();
  await signInAccount(page, worker.baseURL, worker.mailbox, ownerName, "t11r3a-commissioner@example.test");
  await createPool(page, worker.baseURL, slug, "T11R3A Standings", "t11r3a-password");
  await openSeason(page, worker.baseURL, slug, "2026");
  await issueShares(page, worker.baseURL, slug, "3");
  const memberContext = await browser.newContext(); const member = await memberContext.newPage();
  try {
    await worker.resetAuthLimiter();
    await signInAccount(member, worker.baseURL, worker.mailbox, memberName, "t11r3a-member@example.test");
    await joinPool(member, worker.baseURL, slug, "t11r3a-password");
    await issueShares(page, worker.baseURL, slug, "2", memberName);
    await page.goto(`${worker.baseURL}/p/${slug}/standings`);
    expect(await standingsRowTexts(page, ownerName)).toEqual(["1", ownerName, "3.00", "0.00", "3.00", "1.0000", "3.00", "0.00"]);
    expect(await standingsRowTexts(page, memberName)).toEqual(["2", memberName, "2.00", "0.00", "2.00", "1.0000", "2.00", "0.00"]);
    // A real straight ticket moves risk from available to locked without changing the price.
    await reseedUpcomingEvent(page);
    await placeAwaySpreadWager(page, worker.baseURL, slug);
    const wagerId = await lastWagerId(page, slug);
    await page.goto(`${worker.baseURL}/p/${slug}/standings`);
    expect(await standingsRowTexts(page, ownerName)).toEqual(["1", ownerName, "2.00", "1.00", "3.00", "1.0000", "3.00", "0.00"]);
    // Real fixture final + alarm settlement: the win mints 1,000,000 profit into the float (5,000,000 -> 6,000,000)
    // while season notional stays 5,000,000, so the price becomes notional/float = 5/6 -> 0.8333 for every member.
    await settleFixtureResult(page, slug, 17, 24);
    await page.reload();
    expect(await standingsRowTexts(page, ownerName)).toEqual(["1", ownerName, "4.00", "0.00", "4.00", "0.8333", "3.33", "0.33"]);
    expect(await standingsRowTexts(page, memberName)).toEqual(["2", memberName, "2.00", "0.00", "2.00", "0.8333", "1.67", "-0.33"]);
    // A reason-gated regrade of that same ticket to a loss must reverse the prior win's float profit before the
    // loss destroys the risk: 6,000,000 - 1,000,000 - 1,000,000 = 4,000,000, so the price re-prices to 5/4 -> 1.2500.
    // (An earlier revision placed a second fixture push here; that ticket stayed locked because the local alarm
    // control fires at now+10min while the post-final final_15 reconciliation is next due at observed+15min —
    // see test-results/privacy-and-settlement-sta-fa3aa-ettlement-and-after-regrade. Production reschedules its own
    // alarm to that deadline, so the single-ticket journey is the faithful settlement proof.)
    expect(await correctWager(page, slug, wagerId, "lost", "Official scoring correction", "official-loss-v2")).toBe(200);
    await page.goto(`${worker.baseURL}/p/${slug}/standings`);
    // Both members now hold exactly 2.00 shares; the member attained 2.00 at funding while the owner's ledger
    // only returns to 2.00 at the regrade settlement entry, so the earliest-attainment tiebreak swaps the ranks.
    expect(await standingsRowTexts(page, memberName)).toEqual(["1", memberName, "2.00", "0.00", "2.00", "1.2500", "2.50", "0.50"]);
    expect(await standingsRowTexts(page, ownerName)).toEqual(["2", ownerName, "2.00", "0.00", "2.00", "1.2500", "2.50", "-0.50"]);
  } finally { await memberContext.close(); }
});

test("a second ordinary member receives delayed per-leg reveal identical to the commissioner view at each start boundary", async ({ page, browser, worker }) => {
  const slug = "t11r3b-reveal";
  const commissionerName = "T11R3B Commissioner";
  const ticketOwnerName = "T11R3B Ticket Owner";
  const viewerName = "T11R3B Viewer";
  await worker.resetAuthLimiter();
  await signInAccount(page, worker.baseURL, worker.mailbox, commissionerName, "t11r3b-commissioner@example.test");
  await createPool(page, worker.baseURL, slug, "T11R3B Reveal", "t11r3b-password");
  await openSeason(page, worker.baseURL, slug, "2026");
  await issueShares(page, worker.baseURL, slug, "3");
  const ticketOwnerContext = await browser.newContext(); const ticketOwner = await ticketOwnerContext.newPage();
  const viewerContext = await browser.newContext(); const viewer = await viewerContext.newPage();
  try {
    await worker.resetAuthLimiter();
    await signInAccount(ticketOwner, worker.baseURL, worker.mailbox, ticketOwnerName, "t11r3b-owner@example.test");
    await joinPool(ticketOwner, worker.baseURL, slug, "t11r3b-password");
    await worker.resetAuthLimiter();
    await signInAccount(viewer, worker.baseURL, worker.mailbox, viewerName, "t11r3b-viewer@example.test");
    await joinPool(viewer, worker.baseURL, slug, "t11r3b-password");
    await issueShares(page, worker.baseURL, slug, "3", ticketOwnerName);
    // The local board has two truthful scheduled events one minute apart, making every reveal
    // boundary deterministic without waiting or manufacturing a wager/read response.
    await reseedUpcomingEvent(page);
    await ticketOwner.goto(`${worker.baseURL}/p/${slug}/odds`);
    await ticketOwner.getByRole("button", { name: "Select Local Away 3", exact: true }).click();
    await ticketOwner.getByRole("button", { name: "Add selection to teaser" }).click();
    await ticketOwner.getByRole("button", { name: "Select T11 Super Away 4", exact: true }).click();
    await ticketOwner.getByRole("button", { name: "Add selection to teaser" }).click();
    await ticketOwner.getByRole("link", { name: "Build a teaser" }).click();
    await ticketOwner.getByLabel("Risk in whole shares").fill("1");
    await ticketOwner.getByRole("button", { name: "Review teaser wager" }).click();
    await ticketOwner.getByRole("button", { name: "Place teaser" }).click();
    await expect(ticketOwner).toHaveURL(new RegExp(`/p/${slug}/my-wagers$`));

    type RevealLeg = { eventId: string; market: string; selection: string; originalLine: string; adjustedLine: string; eventStartsAt: string; homeTeam: string; awayTeam: string };
    type RevealWager = { type: string; legs?: RevealLeg[] };
    const teaserFrom = (raw: string) => (JSON.parse(raw) as { activity: { wagers: RevealWager[] } }).activity.wagers.find((wager) => wager.type === "teaser")!;
    const forbiddenFutureFields = ["\"legs\"", "\"eventId\"", "\"eventStartsAt\"", "\"market\"", "\"selection\"", "\"originalLine\"", "\"adjustedLine\"", "\"homeTeam\"", "\"awayTeam\"", "legCount", "futureLeg"];

    // The owner receives both accepted snapshots immediately, including their distinct starts.
    const ownerRaw = await activityJson(ticketOwner, slug);
    const ownerTeaser = teaserFrom(ownerRaw);
    expect(ownerTeaser.legs).toHaveLength(2);
    const ownerLegs = [...ownerTeaser.legs!].sort((left, right) => left.eventStartsAt.localeCompare(right.eventStartsAt));
    expect(ownerLegs.map((leg) => leg.eventId)).toEqual(["local-nfl-upcoming", "local-nfl-super-bowl"]);
    expect(new Set(ownerLegs.map((leg) => leg.eventStartsAt)).size).toBe(2);
    const [firstLeg, secondLeg] = ownerLegs;

    // Before either accepted start, neither ordinary nonowner can discover a leg field, team,
    // event, line, market, selection, or count. Commissioner and member bytes are identical.
    const hiddenViewer = await activityJson(viewer, slug);
    const hiddenCommissioner = await activityJson(page, slug);
    expect(hiddenCommissioner).toBe(hiddenViewer);
    expect(teaserFrom(hiddenViewer).legs).toBeUndefined();
    for (const protectedText of [...forbiddenFutureFields, "local-nfl-upcoming", "local-nfl-super-bowl", "Local Home", "Local Away", "T11 Super Home", "T11 Super Away", "riskMicros"]) expect(hiddenViewer).not.toContain(protectedText);
    const teaserSection = (actor: Page) => actor.getByRole("heading", { name: `${ticketOwnerName} — teaser wager` }).locator("..");
    await viewer.goto(`${worker.baseURL}/p/${slug}/activity`);
    await expect(teaserSection(viewer)).toContainText("Selection hidden until start");
    await expect(teaserSection(viewer)).toContainText("Awaiting settlement");
    await expect(teaserSection(viewer)).not.toContainText(commissionerName);
    await page.goto(`${worker.baseURL}/p/${slug}/activity`);
    await expect(teaserSection(page)).toContainText("Selection hidden until start");
    await ticketOwner.goto(`${worker.baseURL}/p/${slug}/activity`);
    await expect(teaserSection(ticketOwner).getByRole("row")).toHaveCount(3);

    // Between accepted starts, only the first leg exists in each nonowner response. No second-event
    // identity, team, line, market, selection, or hidden/future count leaks through JSON or the UI.
    expect(await controlStatus(page, "/__local-test/current-time", { poolSlug: slug, currentTime: new Date(new Date(firstLeg.eventStartsAt).getTime() + 1_000).toISOString() })).toBe(200);
    const firstViewer = await activityJson(viewer, slug);
    const firstCommissioner = await activityJson(page, slug);
    expect(firstCommissioner).toBe(firstViewer);
    const firstVisible = teaserFrom(firstViewer).legs!;
    expect(firstVisible).toHaveLength(1);
    expect(firstVisible[0]).toMatchObject({ eventId: "local-nfl-upcoming", market: "spread", selection: "away", originalLine: "3", adjustedLine: "9", homeTeam: "Local Home", awayTeam: "Local Away" });
    for (const protectedText of [secondLeg.eventId, secondLeg.homeTeam, secondLeg.awayTeam, "legCount", "futureLeg"]) expect(firstViewer).not.toContain(protectedText);
    await viewer.reload();
    const firstRendered = teaserSection(viewer).getByRole("row", { name: /local-nfl-upcoming/ });
    await expect(firstRendered).toContainText("nfl");
    await expect(firstRendered).toContainText("Local Away at Local Home");
    await expect(firstRendered).toContainText("spread");
    await expect(firstRendered).toContainText("away");
    await expect(firstRendered).toContainText("3");
    await expect(firstRendered).toContainText("9");
    await expect(firstRendered).toContainText("DraftKings");
    await expect(teaserSection(viewer)).not.toContainText(secondLeg.eventId);
    await page.goto(`${worker.baseURL}/p/${slug}/activity`);
    await expect(teaserSection(page).getByRole("row", { name: /local-nfl-upcoming/ })).toBeVisible();

    // Crossing only the second accepted start reveals the complete immutable ticket to both nonowners.
    expect(await controlStatus(page, "/__local-test/current-time", { poolSlug: slug, currentTime: new Date(new Date(secondLeg.eventStartsAt).getTime() + 1_000).toISOString() })).toBe(200);
    const bothViewer = await activityJson(viewer, slug);
    const bothCommissioner = await activityJson(page, slug);
    expect(bothCommissioner).toBe(bothViewer);
    const bothLegs = teaserFrom(bothViewer).legs!;
    expect(bothLegs).toHaveLength(2);
    expect(bothLegs.map((leg) => `${leg.eventId}:${leg.market}:${leg.selection}:${leg.originalLine}:${leg.adjustedLine}`).sort()).toEqual(["local-nfl-super-bowl:spread:away:4:10", "local-nfl-upcoming:spread:away:3:9"]);
    await viewer.reload();
    await expect(teaserSection(viewer).getByRole("row", { name: /local-nfl-upcoming/ })).toBeVisible();
    await expect(teaserSection(viewer).getByRole("row", { name: /local-nfl-super-bowl/ })).toBeVisible();
    await page.goto(`${worker.baseURL}/p/${slug}/activity`);
    await expect(teaserSection(page).locator("tbody tr")).toHaveCount(2);
  } finally { await ticketOwnerContext.close(); await viewerContext.close(); }
});

test("commissioner corrections require reasons, preserve every result version, and reject closed-season changes", async ({ page, worker }) => {
  const slug = "t11r5-corrections";
  await worker.resetAuthLimiter();
  await signInAccount(page, worker.baseURL, worker.mailbox, "T11R5 Commissioner", "t11r5-commissioner@example.test");
  await createPool(page, worker.baseURL, slug, "T11R5 Corrections", "t11r5-password");
  await openSeason(page, worker.baseURL, slug, "2026");
  await issueShares(page, worker.baseURL, slug, "3");
  await reseedUpcomingEvent(page);
  await placeAwaySpreadWager(page, worker.baseURL, slug);
  const wagerId = await lastWagerId(page, slug);

  await page.goto(`${worker.baseURL}/p/${slug}/admin/corrections`);
  await expect(page.getByRole("heading", { name: "Wager corrections" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Void with reason" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Regrade with reason" })).toBeDisabled();
  await expect(page.getByRole("row", { name: "straight" })).not.toContainText(/Local Away|Local Home|spread|away/i);
  const exportBeforeProbe = await page.evaluate(async (poolSlug) => JSON.stringify(await (await fetch(`/api/p/${poolSlug}/export`)).json()), slug);
  expect(exportBeforeProbe).not.toContain("local-nfl-upcoming");
  for (const [idempotencyKey, eventId] of [["oracle-correct", "local-nfl-upcoming"], ["oracle-wrong", "guessed-event"]]) {
    const probe = await page.evaluate(async ({ poolSlug, wagerId, idempotencyKey, eventId }) => { const response = await fetch(`/api/p/${poolSlug}/admin/corrections/${wagerId}/regrade`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "Pre-kickoff probe", correctedResults: [{ eventId, league: "nfl", status: "final", homeScore: 17, awayScore: 24, correctionVersion: "guess" }], idempotencyKey }) }); return { status: response.status, code: (await response.json() as { code: string }).code }; }, { poolSlug: slug, wagerId, idempotencyKey, eventId });
    expect(probe).toEqual({ status: 400, code: "WAGER_NOT_STARTED" });
    expect(await page.evaluate(async (poolSlug) => JSON.stringify(await (await fetch(`/api/p/${poolSlug}/export`)).json()), slug)).toBe(exportBeforeProbe);
  }
  const blankReason = await page.evaluate(async ({ poolSlug, wagerId }) => { const response = await fetch(`/api/p/${poolSlug}/admin/corrections/${wagerId}/void`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "   ", idempotencyKey: crypto.randomUUID() }) }); return { status: response.status, code: (await response.json() as { code: string }).code }; }, { poolSlug: slug, wagerId });
  expect(blankReason).toEqual({ status: 400, code: "INVALID_REQUEST" });

  await page.getByLabel("Reason").fill("Refund pending official review");
  await page.getByRole("button", { name: "Void with reason" }).click();
  await expect(page.getByRole("row", { name: "straight" })).toContainText("refunded");
  await settleFixtureResult(page, slug, 17, 24);
  await page.reload();
  const authorizedRow = page.getByRole("table", { name: "Eligible active-season wagers" }).locator("tbody tr").filter({ hasText: /nfl|ncaaf/ }).first();
  const authorizedCells = authorizedRow.locator("th, td");
  const authorizedEventId = (await authorizedCells.nth(3).innerText()).trim();
  const authorizedLeague = (await authorizedCells.nth(4).innerText()).trim();
  const renderedAuthorizedResult = (homeScore: number, awayScore: number, correctionVersion: string) => ({ eventId: authorizedEventId, league: authorizedLeague, status: "final" as const, homeScore, awayScore, correctionVersion });
  expect(authorizedEventId).toBe("local-nfl-upcoming");
  expect(authorizedLeague).toBe("nfl");
  await expect(authorizedRow).not.toContainText(/Local Away|Local Home|spread|away/i);
  await page.getByLabel("Reason").fill("Official review awarded the wager");
  const sourceDerivedCorrections = [renderedAuthorizedResult(17, 24, "official-win-v3"), renderedAuthorizedResult(24, 17, "official-loss-v4")];
  expect(sourceDerivedCorrections.map(({ eventId, league }) => ({ eventId, league }))).toEqual([{ eventId: authorizedEventId, league: authorizedLeague }, { eventId: authorizedEventId, league: authorizedLeague }]);
  await page.getByLabel("Corrected event results").fill(JSON.stringify([sourceDerivedCorrections[0]]));
  await page.getByRole("button", { name: "Regrade with reason" }).click();
  await expect(page.getByRole("row", { name: "straight" }).first()).toContainText("won");
  await page.getByLabel("Reason").fill("Final stat correction reversed the award");
  await page.getByLabel("Corrected event results").fill(JSON.stringify([sourceDerivedCorrections[1]]));
  await page.getByRole("button", { name: "Regrade with reason" }).click();
  await expect(page.getByRole("row", { name: "straight" }).first()).toContainText("lost");

  const history = page.getByRole("region", { name: "Immutable correction history" });
  await expect(history).toContainText("Refund pending official review");
  await expect(history).toContainText("Official review awarded the wager");
  await expect(history).toContainText("Final stat correction reversed the award");
  for (const outcome of ["win", "refund", "loss", "reversal"]) await expect(history).toContainText(outcome);
  const audit = await page.evaluate(async (poolSlug) => await (await fetch(`/api/p/${poolSlug}/export`)).json() as { settlements: Array<{ wagerId: string; outcome: string; resultVersion: string; reversalOf: string | null }>; wagerCorrections: Array<{ wagerId: string; reason: string }> }, slug);
  const settlements = audit.settlements.filter((entry) => entry.wagerId === wagerId);
  expect(settlements.map((entry) => entry.outcome)).toEqual(["refund", "reversal", "win", "reversal", "win", "reversal", "loss"]);
  expect(new Set(settlements.filter((entry) => entry.outcome !== "reversal").map((entry) => entry.resultVersion)).size).toBe(4);
  expect(settlements.filter((entry) => entry.outcome === "reversal").every((entry) => entry.reversalOf)).toBe(true);
  expect(audit.wagerCorrections.filter((entry) => entry.wagerId === wagerId).map((entry) => entry.reason)).toEqual(["Refund pending official review", "Official review awarded the wager", "Final stat correction reversed the award"]);

  expect(await controlStatus(page, "/__local-test/season", { poolSlug: slug, state: "closed" })).toBe(200);
  await page.reload();
  await expect(page.getByText("No eligible active-season wagers are available for correction.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Void with reason" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Regrade with reason" })).toHaveCount(0);
  const closedCorrection = renderedAuthorizedResult(17, 24, "closed-v5");
  const closedDenied = await page.evaluate(async ({ poolSlug, wagerId, correctedResult }) => { const response = await fetch(`/api/p/${poolSlug}/admin/corrections/${wagerId}/regrade`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "Closed boundary attempt", correctedResults: [correctedResult], idempotencyKey: crypto.randomUUID() }) }); return { status: response.status, code: (await response.json() as { code: string }).code }; }, { poolSlug: slug, wagerId, correctedResult: closedCorrection });
  expect(closedDenied).toEqual({ status: 400, code: "SEASON_NOT_ACTIVE" });
  const afterDenied = await page.evaluate(async (poolSlug) => await (await fetch(`/api/p/${poolSlug}/export`)).json() as { settlements: unknown[]; wagerCorrections: unknown[] }, slug);
  expect(afterDenied.settlements).toHaveLength(audit.settlements.length);
  expect(afterDenied.wagerCorrections).toHaveLength(audit.wagerCorrections.length);
});

test("activity stays immutable and presents only the current settlement without contradictory awaiting text", async ({ page, browser, worker }) => {
  const slug = "t11r3c-activity";
  const commissionerName = "T11R3C Commissioner";
  const memberName = "T11R3C Member";
  await worker.resetAuthLimiter();
  await signInAccount(page, worker.baseURL, worker.mailbox, commissionerName, "t11r3c-commissioner@example.test");
  await createPool(page, worker.baseURL, slug, "T11R3C Activity", "t11r3c-password");
  await openSeason(page, worker.baseURL, slug, "2026");
  await issueShares(page, worker.baseURL, slug, "3");
  const memberContext = await browser.newContext(); const member = await memberContext.newPage();
  try {
    await worker.resetAuthLimiter();
    await signInAccount(member, worker.baseURL, worker.mailbox, memberName, "t11r3c-member@example.test");
    await joinPool(member, worker.baseURL, slug, "t11r3c-password");
    await reseedUpcomingEvent(page);
    await placeAwaySpreadWager(page, worker.baseURL, slug);
    const wagerId = await lastWagerId(page, slug);
    await settleFixtureResult(page, slug, 17, 24);
    // The owner's activity carries the current outcome; the immutable funding order is member-visible.
    await page.goto(`${worker.baseURL}/p/${slug}/activity`);
    await expect(page.getByRole("row", { name: commissionerName })).toContainText("3.00 shares");
    await expect(page.getByRole("row", { name: commissionerName })).toContainText("3.00 virtual value");
    const ownerWager = page.getByRole("heading", { name: `${commissionerName} — straight wager` }).locator("..");
    await expect(ownerWager).toContainText("Current outcome: won");
    // A nonowner sees the same immutable rows with neutral settled presentation and no protected field.
    await member.goto(`${worker.baseURL}/p/${slug}/activity`);
    await expect(member.getByRole("row", { name: commissionerName })).toContainText("3.00 shares");
    const memberWager = member.getByRole("heading", { name: `${commissionerName} — straight wager` }).locator("..");
    await expect(memberWager).toContainText("won");
    await expect(memberWager).toContainText("Settled");
    await expect(memberWager).not.toContainText("Awaiting settlement");
    const hidden = await activityJson(member, slug);
    expect(hidden).not.toContain("riskMicros");
    expect(hidden).not.toContain("Current outcome");
    expect(hidden).toContain("Local Away");
    // The correction chain replaces only the current outcome presentation, never the rows themselves.
    expect(await correctWager(page, slug, wagerId, "lost", "Official scoring correction", "official-loss-v2")).toBe(200);
    await page.goto(`${worker.baseURL}/p/${slug}/activity`);
    await expect(ownerWager).toContainText("Current outcome: lost");
    await expect(ownerWager).not.toContainText("Current outcome: won");
    await member.reload();
    await expect(memberWager).toContainText("lost");
    await expect(memberWager).toContainText("Settled");
    await expect(memberWager).not.toContainText("Awaiting settlement");
    expect(await correctWager(page, slug, wagerId, "refunded", "Settled ticket voided", "official-void-v3")).toBe(200);
    await page.goto(`${worker.baseURL}/p/${slug}/activity`);
    await expect(ownerWager).toContainText("Current outcome: refunded");
    await expect(ownerWager).not.toContainText("Current outcome: lost");
    await member.reload();
    await expect(memberWager).toContainText("refunded");
    await expect(memberWager).toContainText("Settled");
    await expect(memberWager).not.toContainText("Awaiting settlement");
    // Immutable audit: the funding order and exactly one wager row remain after every correction.
    await expect(page.getByRole("row", { name: commissionerName })).toContainText("3.00 shares");
    await expect(page.getByRole("row", { name: commissionerName })).toContainText("3.00 virtual value");
    expect(await page.getByRole("heading", { name: `${commissionerName} — straight wager` }).count()).toBe(1);
    expect(await member.getByRole("heading", { name: `${commissionerName} — straight wager` }).count()).toBe(1);
  } finally { await memberContext.close(); }
});

test("fixture close archives the season for members with append-only commissioner annotation", async ({ page, browser, worker }) => {
  const slug = "t11r3d-archive";
  const commissionerName = "T11R3D Commissioner";
  const memberName = "T11R3D Member";
  await worker.resetAuthLimiter();
  await signInAccount(page, worker.baseURL, worker.mailbox, commissionerName, "t11r3d-commissioner@example.test");
  await createPool(page, worker.baseURL, slug, "T11R3D Archive", "t11r3d-password");
  await openSeason(page, worker.baseURL, slug, "2026");
  await issueShares(page, worker.baseURL, slug, "3");
  const memberContext = await browser.newContext(); const member = await memberContext.newPage();
  try {
    await worker.resetAuthLimiter();
    await signInAccount(member, worker.baseURL, worker.mailbox, memberName, "t11r3d-member@example.test");
    await joinPool(member, worker.baseURL, slug, "t11r3d-password");
    await reseedUpcomingEvent(page);
    await placeAwaySpreadWager(page, worker.baseURL, slug);
    const activeSeasonId = await page.evaluate(async (poolSlug) => (await (await fetch(`/api/p/${poolSlug}/view`)).json() as { activeSeason: { id: string } }).activeSeason.id, slug);
    await page.goto(`${worker.baseURL}/p/${slug}/history/${activeSeasonId}`);
    await expect(page.getByRole("alert")).toContainText("This season is still active or in draft. Open its archive after the season closes.");
    await settleFixtureResult(page, slug, 17, 24);
    // Fixture-arranged close through the documented local lifecycle control.
    expect(await controlStatus(page, "/__local-test/season", { poolSlug: slug, state: "closed" })).toBe(200);
    // Ordinary-member discovery: the overview surfaces the closed season and the archive stays member-readable.
    await member.goto(`${worker.baseURL}/p/${slug}/overview`);
    await expect(member.getByText("No active season.")).toBeVisible();
    await member.getByRole("link", { name: "2026", exact: true }).click();
    await expect(member).toHaveURL(new RegExp(`/p/${slug}/history/[^/]+$`));
    await expect(member.getByRole("heading", { name: "Archived season: 2026" })).toBeVisible();
    await expect(member.getByText("Read-only closed season.")).toBeVisible();
    await expect(member.getByText("Closed: Local lifecycle test transition.")).toBeVisible();
    const finalAccounting = member.getByRole("table", { name: "Final season accounting" });
    await expect(finalAccounting).toContainText("4.00 shares");
    await expect(finalAccounting.getByRole("row", { name: "Ruleset version SHARE_POOL_2026_V1" })).toBeVisible();
    const archivedRules = member.getByRole("link", { name: "matching immutable SHARE_POOL_2026_V1 payout table" });
    await expect(archivedRules).toHaveAttribute("href", `/p/${slug}/rules#teaser-rules-heading`);
    await expect(member.getByText(/This archived version remains authoritative/)).toBeVisible();
    await expect(member.getByRole("table", { name: "Every season account" })).toContainText(commissionerName);
    await expect(member.getByRole("table", { name: "Final rank by share holdings" })).toContainText("3.00");
    await expect(member.getByRole("table", { name: "Append-only share orders" })).toContainText("Commissioner share issue");
    await expect(member.getByRole("table", { name: "Append-only accounting ledger" })).toContainText("settlement");
    await expect(member.getByRole("table", { name: "Append-only wager settlements" })).toContainText("win");
    await expect(member.getByText("No commissioner corrections were recorded.")).toBeVisible();
    const archived = await member.evaluate(async ({ poolSlug, seasonId }) => await (await fetch(`/api/p/${poolSlug}/history/${seasonId}`)).json() as any, { poolSlug: slug, seasonId: activeSeasonId });
    expect(archived.season).toMatchObject({ seasonId: activeSeasonId, floatMicros: "4000000", notionalMicros: "3000000", priceMicros: "750000" });
    expect(archived.orders.every((row: any) => row.seasonId === activeSeasonId)).toBe(true);
    expect(archived.ledger.every((row: any) => row.seasonId === activeSeasonId)).toBe(true);
    expect(archived.wagers.every((row: any) => row.seasonId === activeSeasonId)).toBe(true);
    const memberWagerRow = member.getByRole("heading", { name: `${commissionerName} — straight wager` }).locator("..");
    await expect(memberWagerRow).toContainText("won");
    await expect(memberWagerRow).toContainText("Settled");
    await expect(memberWagerRow.getByRole("row", { name: /local-nfl-upcoming/ })).toContainText("Local Away at Local Home");
    await expect(member.getByText("No annotations yet.")).toBeVisible();
    await expect(member.getByLabel("Add annotation")).toHaveCount(0);
    // The page-wide button count would include only the session-derived "Log out" nav control (Layout),
    // which every signed-in route renders; the archived view itself must expose no interactive control.
    await expect(member.getByRole("button", { name: "Log out" })).toBeVisible();
    await expect(member.getByRole("main").getByRole("button")).toHaveCount(0);
    // The command boundary agrees: the member's real annotation POST is role-denied with no write.
    const seasonId = new URL(member.url()).pathname.split("/").filter(Boolean).pop()!;
    const denied = await member.evaluate(async ({ poolSlug, seasonId }) => {
      const response = await fetch(`/api/p/${poolSlug}/admin/history/${seasonId}/annotations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Member attempt", idempotencyKey: crypto.randomUUID() }) });
      return { status: response.status, code: (await response.json() as { code: string }).code };
    }, { poolSlug: slug, seasonId });
    expect(denied).toEqual({ status: 403, code: "FORBIDDEN" });
    const wagerRowBefore = await memberWagerRow.innerText();
    // The commissioner appends annotations; the closed history itself never changes.
    await page.goto(`${worker.baseURL}/p/${slug}/overview`);
    await page.getByRole("link", { name: "2026", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Archived season: 2026" })).toBeVisible();
    const annotationPath = `/api/p/${slug}/admin/history/${seasonId}/annotations`;
    expect(await controlStatus(page, "/__local-test/response-barrier", { mode: "drop", pathname: annotationPath })).toBe(200);
    await page.getByLabel("Add annotation").fill("Archived after the fixture settlement window.");
    await page.getByRole("button", { name: "Add annotation" }).click();
    await expect(page.getByRole("button", { name: "Add annotation" })).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText("Unable to complete this request", { timeout: 8_000 });
    await expect(page.getByRole("button", { name: "Add annotation" })).toBeEnabled();
    // The first real PoolDO append completed behind the dropped response. Retry must replay its exact body/key.
    await page.getByRole("button", { name: "Add annotation" }).click();
    await expect(page.getByRole("listitem").first()).toContainText("Archived after the fixture settlement window.");
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByRole("listitem").first()).toContainText(commissionerName);
    await page.getByLabel("Add annotation").fill("Final standings certified.");
    await page.getByRole("button", { name: "Add annotation" }).click();
    await expect(page.getByRole("listitem")).toHaveCount(2);
    // The member sees the append-only annotations and unchanged closed history with no editing control.
    await member.reload();
    const annotations = member.getByRole("listitem");
    await expect(annotations).toHaveCount(2);
    await expect(annotations.first()).toContainText("Archived after the fixture settlement window.");
    await expect(annotations.first()).toContainText(commissionerName);
    await expect(annotations.last()).toContainText("Final standings certified.");
    expect(await memberWagerRow.innerText()).toBe(wagerRowBefore);
    await expect(member.getByRole("main").getByRole("button")).toHaveCount(0);
  } finally { await memberContext.close(); }
});

test("suspension denies an ordinary member with an actionable overview denial until restore", async ({ page, browser, worker }) => {
  const slug = "t11r4a-suspend";
  const commissionerName = "T11R4A Commissioner";
  const memberName = "T11R4A Member";
  await worker.resetAuthLimiter();
  await signInAccount(page, worker.baseURL, worker.mailbox, commissionerName, "t11r4a-commissioner@example.test");
  await createPool(page, worker.baseURL, slug, "T11R4A Suspend", "t11r4a-password");
  const memberContext = await browser.newContext(); const member = await memberContext.newPage();
  try {
    await worker.resetAuthLimiter();
    await signInAccount(member, worker.baseURL, worker.mailbox, memberName, "t11r4a-member@example.test");
    await joinPool(member, worker.baseURL, slug, "t11r4a-password");
    expect(await member.evaluate(async (poolSlug) => (await fetch(`/api/p/${poolSlug}/standings`)).status, slug)).toBe(200);
    // The commissioner suspends the ordinary member through the real members administration page.
    await page.goto(`${worker.baseURL}/p/${slug}/admin/members`);
    const memberRow = page.getByRole("row", { name: memberName });
    await memberRow.getByRole("button", { name: "Suspend" }).click();
    await expect(memberRow).toContainText("suspended");
    await expect(memberRow.getByRole("button", { name: "Restore" })).toBeVisible();
    // The member's overview must deny access actionably, not hang on its loading status forever.
    await member.goto(`${worker.baseURL}/p/${slug}/overview`);
    await expect(member.getByRole("status")).toHaveCount(0);
    await expect(member.getByRole("alert")).toContainText("suspended");
    // A member read page agrees with the same actionable denial instead of a raw code.
    await member.goto(`${worker.baseURL}/p/${slug}/standings`);
    await expect(member.getByRole("alert")).toContainText("suspended");
    // The authoritative boundary denies every member read with the suspended role gate.
    for (const path of ["view", "standings", "activity"]) {
      const denied = await member.evaluate(async ({ poolSlug, path }) => { const response = await fetch(`/api/p/${poolSlug}/${path}`); return { status: response.status, code: (await response.json() as { code: string }).code }; }, { poolSlug: slug, path });
      expect(denied, path).toEqual({ status: 403, code: "SUSPENDED" });
    }
    // The suspended member's own join command is denied by the PoolDO gate, not the transport.
    const deniedJoin = await member.evaluate(async ({ poolSlug, password }) => { const response = await fetch(`/api/p/${poolSlug}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, idempotencyKey: crypto.randomUUID() }) }); return { status: response.status, code: (await response.json() as { code: string }).code }; }, { poolSlug: slug, password: "t11r4a-password" });
    expect(deniedJoin).toEqual({ status: 403, code: "SUSPENDED" });
    // Restore returns full member access through the same real controls.
    await memberRow.getByRole("button", { name: "Restore" }).click();
    await expect(memberRow).toContainText("active");
    await member.goto(`${worker.baseURL}/p/${slug}/overview`);
    await expect(member.getByRole("heading", { name: "T11R4A Suspend" })).toBeVisible();
    expect(await member.evaluate(async (poolSlug) => (await fetch(`/api/p/${poolSlug}/standings`)).status, slug)).toBe(200);
  } finally { await memberContext.close(); }
});

test("commissioner transfer honors self, blank-reason, nonmember, recent-auth, and suspended prohibitions before handover", async ({ page, browser, worker }) => {
  const slug = "t11r4b-transfer";
  const commissionerName = "T11R4B Commissioner";
  const memberName = "T11R4B Member";
  const commissionerEmail = "t11r4b-commissioner@example.test";
  await worker.resetAuthLimiter();
  await signInAccount(page, worker.baseURL, worker.mailbox, commissionerName, commissionerEmail);
  await createPool(page, worker.baseURL, slug, "T11R4B Transfer", "t11r4b-password");
  const memberContext = await browser.newContext(); const member = await memberContext.newPage();
  const visitorContext = await browser.newContext(); const visitor = await visitorContext.newPage();
  try {
    await worker.resetAuthLimiter();
    await signInAccount(member, worker.baseURL, worker.mailbox, memberName, "t11r4b-member@example.test");
    await joinPool(member, worker.baseURL, slug, "t11r4b-password");
    const memberUserId = await sessionUserId(member);
    // A real, signed-in account that never joined is the nonmember transfer target.
    await worker.resetAuthLimiter();
    await signInAccount(visitor, worker.baseURL, worker.mailbox, "T11R4B Visitor", "t11r4b-visitor@example.test");
    const visitorUserId = await sessionUserId(visitor);
    const commissionerUserId = await sessionUserId(page);
    await page.goto(`${worker.baseURL}/p/${slug}/admin/members`);
    const memberRow = page.getByRole("row", { name: memberName });
    const commissionerRow = page.getByRole("row", { name: commissionerName });
    // Self-transfer is never offered: only the ordinary member's row carries the control.
    await expect(page.getByRole("button", { name: "Transfer commissioner" })).toHaveCount(1);
    await expect(commissionerRow.getByRole("button", { name: "Transfer commissioner" })).toHaveCount(0);
    // A blank audit reason keeps the command unavailable at the UI and rejected at the boundary.
    await expect(memberRow.getByRole("button", { name: "Transfer commissioner" })).toBeDisabled();
    expect(await transferStatus(page, slug, memberUserId, "  ")).toEqual({ status: 400, code: "INVALID_REQUEST" });
    // A real nonmember account is not a transfer target.
    expect(await transferStatus(page, slug, visitorUserId, "Documented handover")).toEqual({ status: 400, code: "MEMBER_NOT_FOUND" });
    // Recent authentication is required: an aged session is denied at UI and boundary alike.
    expect(await expireRecentAuth(page, commissionerUserId)).toBe(200);
    await page.getByLabel("Transfer reason").fill("Documented handover after the season.");
    await memberRow.getByRole("button", { name: "Transfer commissioner" }).click();
    await expect(page.getByRole("alert")).toContainText("sign in again");
    expect(await transferStatus(page, slug, memberUserId, "Documented handover")).toEqual({ status: 403, code: "RECENT_AUTH_REQUIRED" });
    await worker.resetAuthLimiter();
    await logInAgain(page, worker.baseURL, commissionerEmail);
    // A suspended member cannot receive the commissioner role: UI hides the control, boundary denies.
    await page.goto(`${worker.baseURL}/p/${slug}/admin/members`);
    await memberRow.getByRole("button", { name: "Suspend" }).click();
    await expect(page.getByRole("button", { name: "Transfer commissioner" })).toHaveCount(0);
    expect(await transferStatus(page, slug, memberUserId, "Documented handover")).toEqual({ status: 403, code: "SUSPENDED" });
    await memberRow.getByRole("button", { name: "Restore" }).click();
    await expect(memberRow).toContainText("active");
    // The real handover: the same page immediately loses commissioner controls.
    await page.getByLabel("Transfer reason").fill("Documented handover after the season.");
    await memberRow.getByRole("button", { name: "Transfer commissioner" }).click();
    await expect(page.getByText("Only the commissioner can manage members.")).toBeVisible();
    await page.goto(`${worker.baseURL}/p/${slug}/overview`);
    await expect(page.getByRole("link", { name: "Members", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
    expect(await transferStatus(page, slug, memberUserId, "Reclaim attempt")).toEqual({ status: 403, code: "FORBIDDEN" });
    // The new commissioner gains exactly the controls the old one lost.
    await member.goto(`${worker.baseURL}/p/${slug}/overview`);
    await expect(member.getByRole("link", { name: "Members", exact: true })).toBeVisible();
    await member.goto(`${worker.baseURL}/p/${slug}/admin/members`);
    await expect(member.getByRole("heading", { name: "Member administration" })).toBeVisible();
    await expect(member.getByRole("row", { name: memberName }).getByRole("cell").first()).toHaveText("commissioner");
    await expect(member.getByRole("row", { name: commissionerName }).getByRole("cell").first()).toHaveText("member");
    await expect(member.getByRole("button", { name: "Suspend" })).toHaveCount(1);
  } finally { await memberContext.close(); await visitorContext.close(); }
});

test("settings rename, signup closure, and recent-auth password rotation reshape member entry exactly as commanded", async ({ page, browser, worker }) => {
  const slug = "t11r4c-settings";
  const commissionerEmail = "t11r4c-commissioner@example.test";
  const firstPassword = "t11r4c-first-password";
  const rotatedPassword = "t11r4c-rotated-password";
  await worker.resetAuthLimiter();
  await signInAccount(page, worker.baseURL, worker.mailbox, "T11R4C Commissioner", commissionerEmail);
  await createPool(page, worker.baseURL, slug, "T11R4C Settings", firstPassword);
  const memberAContext = await browser.newContext(); const memberA = await memberAContext.newPage();
  const memberBContext = await browser.newContext(); const memberB = await memberBContext.newPage();
  const memberCContext = await browser.newContext(); const memberC = await memberCContext.newPage();
  try {
    // Control: the first join password genuinely admits a member before any rotation.
    await worker.resetAuthLimiter();
    await signInAccount(memberA, worker.baseURL, worker.mailbox, "T11R4C Member A", "t11r4c-member-a@example.test");
    await joinPool(memberA, worker.baseURL, slug, firstPassword);
    // Renaming is an ordinary commissioner setting and is visible everywhere the pool name renders.
    await page.goto(`${worker.baseURL}/p/${slug}/admin/settings`);
    await page.getByLabel("Pool name").fill("T11R4C Renamed");
    await page.getByRole("button", { name: "Rename pool" }).click();
    await page.goto(`${worker.baseURL}/p/${slug}/overview`);
    await expect(page.getByRole("heading", { name: "T11R4C Renamed" })).toBeVisible();
    // Password rotation demands recent authentication: an aged session is refused with an actionable re-auth notice.
    const commissionerUserId = await sessionUserId(page);
    expect(await expireRecentAuth(page, commissionerUserId)).toBe(200);
    await page.goto(`${worker.baseURL}/p/${slug}/admin/settings`);
    await expect(page.getByText("Signups are open.")).toBeVisible();
    await page.getByLabel("New join password").fill(rotatedPassword);
    await page.getByRole("button", { name: "Rotate password" }).click();
    await expect(page.getByRole("alert")).toContainText("sign in again");
    // The denied command leaves the page on its terminal error summary; a reload restores the form.
    await page.goto(`${worker.baseURL}/p/${slug}/admin/settings`);
    // Signup closure skips that gate: the same aged session still closes and reopens signups.
    await page.getByRole("button", { name: "Close signups" }).click();
    await expect(page.getByText("Signups are closed.")).toBeVisible();
    await worker.resetAuthLimiter();
    await signInAccount(memberC, worker.baseURL, worker.mailbox, "T11R4C Member C", "t11r4c-member-c@example.test");
    await memberC.goto(`${worker.baseURL}/p/${slug}`);
    await expect(memberC.getByRole("heading", { name: "This pool is not accepting members" })).toBeVisible();
    await expect(memberC.getByText("No pool information is available here.")).toBeVisible();
    await page.getByRole("button", { name: "Open signups" }).click();
    await expect(page.getByText("Signups are open.")).toBeVisible();
    await joinPool(memberC, worker.baseURL, slug, firstPassword);
    // A freshly authenticated commissioner rotates the password for real.
    await worker.resetAuthLimiter();
    await logInAgain(page, worker.baseURL, commissionerEmail);
    await page.goto(`${worker.baseURL}/p/${slug}/admin/settings`);
    await page.getByLabel("New join password").fill(rotatedPassword);
    await page.getByRole("button", { name: "Rotate password" }).click();
    await expect(page.getByLabel("New join password")).toHaveValue("");
    // The old password no longer admits anyone; the rotated password does.
    await worker.resetAuthLimiter();
    await signInAccount(memberB, worker.baseURL, worker.mailbox, "T11R4C Member B", "t11r4c-member-b@example.test");
    await memberB.goto(`${worker.baseURL}/p/${slug}`);
    await expect(memberB.getByRole("heading", { name: "Join T11R4C Renamed" })).toBeVisible();
    await memberB.getByLabel("Pool password").fill(firstPassword);
    await memberB.getByRole("button", { name: "Join pool" }).click();
    await expect(memberB.getByRole("alert")).toContainText("The password was not accepted or signup is no longer available");
    await memberB.getByLabel("Pool password").fill(rotatedPassword);
    await memberB.getByRole("button", { name: "Join pool" }).click();
    await expect(memberB).toHaveURL(new RegExp(`/p/${slug}/overview$`));
  } finally { await memberAContext.close(); await memberBContext.close(); await memberCContext.close(); }
});
