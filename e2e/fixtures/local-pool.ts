import { expect, type Page } from "@playwright/test";

type LocalWorker = {
  baseURL: string;
  resetAuthLimiter: () => Promise<void>;
};

type Credentials = { name: string; email: string; password?: string };
export type ActivePool = { slug: string; name: string; seasonId: string; seasonLabel: string };

/** Creates a real local account and browser session; no auth routes are mocked. */
export async function signIn(page: Page, worker: LocalWorker, credentials: Credentials) {
  const password = credentials.password ?? "first-password";
  await page.context().clearCookies();
  await worker.resetAuthLimiter();
  await page.goto(`${worker.baseURL}/sign-up`);
  await page.getByLabel("Name").fill(credentials.name);
  await page.getByLabel("Email address").fill(credentials.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "log in", exact: true })).toBeVisible();
  await worker.resetAuthLimiter();
  await page.getByRole("link", { name: "log in", exact: true }).click();
  await page.getByLabel("Email address").fill(credentials.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Your pools" })).toBeVisible();
}

/** Creates an active pool through its real browser surfaces, then opens its season through its authenticated command API. */
export async function createActivePool(page: Page, worker: LocalWorker, input: Pick<ActivePool, "slug" | "name">): Promise<ActivePool> {
  await signIn(page, worker, { name: `${input.name} Commissioner`, email: `${input.slug}@example.test` });
  await page.goto(`${worker.baseURL}/pools/new`);
  await page.getByLabel("Pool name").fill(input.name);
  await page.getByLabel("Pool web address").fill(input.slug);
  await page.getByLabel("Join password").fill("local-pool-password");
  await page.getByRole("button", { name: "Create pool" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${input.slug}/odds$`));
  const seasonId = crypto.randomUUID(); const seasonLabel = "Accessibility 2026";
  await page.evaluate(async ({ slug, seasonId, seasonLabel }) => {
    const created = await fetch(`/api/p/${slug}/admin/seasons`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seasonId, label: seasonLabel, idempotencyKey: crypto.randomUUID() }) });
    if (!created.ok) throw new Error(`/admin/seasons failed: ${created.status}`);
    const opened = await fetch(`/api/p/${slug}/admin/seasons/${seasonId}/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) });
    if (!opened.ok) throw new Error(`/admin/seasons/${seasonId}/open failed: ${opened.status}`);
  }, { slug: input.slug, seasonId, seasonLabel });
  return { ...input, seasonId, seasonLabel };
}
