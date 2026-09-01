import { test, expect } from "./fixtures/local-worker";

async function signInOwner(page: import("@playwright/test").Page, baseURL: string, mailbox: () => Promise<Array<{ kind: "verification"; to: string; token: string }>>) {
  await page.goto(`${baseURL}/sign-up`);
  await page.getByLabel("Name").fill("Same Game Owner");
  await page.getByLabel("Email address").fill("same-game-owner@example.test");
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("link", { name: "log in", exact: true }).click();
  await page.getByLabel("Email address").fill("same-game-owner@example.test");
  await page.getByLabel("Password").fill("first-password");
  await page.getByRole("button", { name: "Log in" }).click();
}

const result = (homeScore: number, awayScore: number, correctionVersion: string) => ({ eventId: "local-nfl-upcoming", homeScore, awayScore, correctionVersion });

test("authenticated browser parser consumes the real same-game teaser export across corrections", async ({ page, worker }) => {
  const slug = "same-game-export-pool";
  await signInOwner(page, worker.baseURL, worker.mailbox);
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill("Same Game Export Pool");
  await page.getByLabel("Pool web address").fill(slug);
  await page.getByLabel("Join password").fill("same-game-password");
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

  await page.getByRole("link", { name: "Games", exact: true }).click();
  await page.getByRole("checkbox", { name: "Local Home -3", exact: true }).check();
  await page.getByRole("checkbox", { name: "O 45.5", exact: true }).check();
  await page.getByRole("button", { name: "Build teaser" }).click();
  await page.getByLabel("Risk", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Review teaser wager" }).click();
  await page.getByRole("button", { name: "Place teaser" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${slug}/my-wagers$`));
  const wagerId = await page.evaluate(async (poolSlug) => ((await (await fetch(`/api/p/${poolSlug}/wagers`)).json()) as { wagers: Array<{ wagerId: string }> }).wagers[0]!.wagerId, slug);

  const alarmAt = new Date(Date.now() + 10 * 60_000);
  expect(await page.evaluate(async (body) => (await fetch("/__local-test/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, result(24, 17, "provider-1"))).toBe(200);
  const trigger = async (at: Date) => page.evaluate(async ({ poolSlug, currentTime }) => (await fetch("/__local-test/alarm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug, currentTime }) })).status, { poolSlug: slug, currentTime: at.toISOString() });
  expect(await trigger(alarmAt)).toBe(200);
  expect(await page.evaluate(async ({ poolSlug, currentTime }) => (await fetch("/__local-test/current-time", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug, currentTime }) })).status, { poolSlug: slug, currentTime: alarmAt.toISOString() })).toBe(200);

  await page.goto(`${worker.baseURL}/p/${slug}/admin/corrections`);
  await expect(page.getByRole("heading", { name: "Immutable correction history" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "win", exact: true })).toBeVisible();
  const exported = async () => page.evaluate(async (poolSlug) => (await (await fetch(`/api/p/${poolSlug}/export`)).json()), slug) as Promise<any>;
  const automatic = await exported();
  expect(automatic.settlements[0].sourceResult).toEqual([{ eventId: "local-nfl-upcoming", league: "nfl", status: "final", homeScore: 24, awayScore: 17, correctionVersion: "provider-1", eventName: null, postseason: false }]);
  expect(automatic.wagers[0]).toMatchObject({ wagerId, type: "teaser", status: "won", riskMicros: "1000000", acceptedOdds: -120, outcome: "won", returnMicros: "1833333", profitMicros: "833333", legs: [expect.objectContaining({ market: "spread", grade: "win", resultVersion: "provider-1" }), expect.objectContaining({ market: "total", grade: "win", resultVersion: "provider-1" })] });
  expect(JSON.stringify(automatic)).not.toMatch(/canonicalOfferProof|ownerMemberId/);

  const authorizedRow = page.getByRole("table", { name: "Eligible active-season wagers" }).locator("tbody tr").filter({ hasText: /nfl|ncaaf/ }).first();
  const authorizedCells = authorizedRow.locator("th, td");
  const authorizedEventId = (await authorizedCells.nth(3).innerText()).trim();
  const authorizedLeague = (await authorizedCells.nth(4).innerText()).trim();
  expect(authorizedEventId).toBe("local-nfl-upcoming");
  expect(authorizedLeague).toBe("nfl");
  await expect(authorizedRow).not.toContainText(/Local Away|Local Home|spread|total|over/i);
  const correctedResults = [{ eventId: authorizedEventId, league: authorizedLeague, status: "final", homeScore: 17, awayScore: 24, correctionVersion: "official-2" }];
  await page.getByLabel("Reason").fill("Official correction");
  await page.getByLabel("Corrected event results").fill(JSON.stringify(correctedResults));
  await page.getByRole("button", { name: "Regrade with reason" }).click();
  await expect.poll(async () => (await exported()).settlements.length).toBe(3);
  const manual = await exported();
  expect(manual.wagers[0]).toMatchObject({ status: "lost", outcome: "lost", returnMicros: "0", profitMicros: "0" });
  expect(manual.settlements.map((entry: any) => entry.outcome)).toEqual(["win", "reversal", "loss"]);
  expect(manual.wagerCorrections).toEqual([expect.objectContaining({ wagerId, reason: "Official correction", sourceResult: automatic.settlements[0].sourceResult, replacementResult: expect.objectContaining({ correctedResults }) })]);
  expect(manual.administrationAudit).toEqual([expect.objectContaining({ action: "regrade_wager", subjectId: wagerId, reason: "Official correction" })]);

  expect(await page.evaluate(async (body) => (await fetch("/__local-test/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, result(24, 17, "provider-1"))).toBe(200);
  expect(await trigger(new Date(alarmAt.getTime() + 20 * 60_000))).toBe(200);
  expect(await exported()).toEqual(manual);

  expect(await page.evaluate(async (body) => (await fetch("/__local-test/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, result(28, 17, "provider-2"))).toBe(200);
  expect(await trigger(new Date(alarmAt.getTime() + 25 * 60 * 60_000))).toBe(200);
  const providerCorrection = await exported();
  expect(providerCorrection.wagers[0]).toMatchObject({ status: "won", outcome: "won", returnMicros: "1833333", profitMicros: "833333", legs: [expect.objectContaining({ grade: "win", resultVersion: "provider-2" }), expect.objectContaining({ grade: "win", resultVersion: "provider-2" })] });
  expect(providerCorrection.settlements.map((entry: any) => entry.outcome)).toEqual(["win", "reversal", "loss", "reversal", "win"]);
  expect(providerCorrection.wagerCorrections).toEqual(manual.wagerCorrections);
  expect(providerCorrection.administrationAudit).toEqual(manual.administrationAudit);
});
