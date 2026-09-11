import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { createOperationalAlerts } from "../../src/services/operational-alerts";

const db = (env as unknown as { DB: D1Database }).DB;
let migrated = false;
beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(db, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await db.exec("DROP TABLE IF EXISTS operational_alert_throttle; DELETE FROM user;");
  for (const [id, email] of [["ops-a", "ops-a@example.test"], ["ops-b", "ops-b@example.test"], ["member", "member@example.test"]]) await db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)").bind(id, id, email).run();
});

const config = () => ({ DB: db, RESEND_API_KEY: "test-only", OPS_OPERATOR_USER_IDS: "ops-a,ops-b" });
describe("best-effort operational mail", () => {
  it("is disabled without mail and an unambiguous operator allowlist", () => {
    for (const configured of [undefined, "", "ops-a,", "ops-a,ops-a"]) expect(createOperationalAlerts({ ...config(), OPS_OPERATOR_USER_IDS: configured })).toBeUndefined();
    expect(createOperationalAlerts({ ...config(), RESEND_API_KEY: "" })).toBeUndefined();
  });

  it("only emails configured operator accounts and escapes scope details", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const alerts = createOperationalAlerts(config(), { fetcher })!;
    await alerts.report({ kind: "settlement_overdue", scope: "pool<&>", count: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const messages = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(messages.map(m => m.to)).toEqual([["ops-a@example.test"], ["ops-b@example.test"]]);
    expect(messages[0].html).toContain("pool&lt;&amp;&gt;");
    expect(messages[0].text).toContain("20 minutes");
    expect(messages[0].text).toContain("2");
    expect(messages[0].html).toContain("https://officepool.football/ops");
  });

  it("atomically throttles concurrent attempts per category and scope for 30 minutes", async () => {
    let now = 1_000_000;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const alerts = createOperationalAlerts({ ...config(), OPS_OPERATOR_USER_IDS: "ops-a" }, { fetcher, clock: () => now })!;
    await Promise.all(Array.from({ length: 6 }, () => alerts.report({ kind: "settlement", scope: "pool-a" })));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await alerts.report({ kind: "placement", scope: "pool-a" });
    await alerts.report({ kind: "settlement", scope: "pool-b" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    now += 30 * 60 * 1000 - 1;
    await alerts.report({ kind: "settlement", scope: "pool-a" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    now++;
    await alerts.report({ kind: "settlement", scope: "pool-a" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("isolates provider failures, retains the cooldown, and never throws on D1 failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("mail failed")).mockResolvedValue(new Response("{}"));
    const alerts = createOperationalAlerts(config(), { fetcher })!;
    await expect(alerts.report({ kind: "odds_update", scope: "global" })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await alerts.report({ kind: "odds_update", scope: "global" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const broken = createOperationalAlerts({ ...config(), DB: { prepare() { throw new Error("D1 unavailable"); } } as unknown as D1Database }, { fetcher })!;
    await expect(broken.report({ kind: "placement", scope: "pool" })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
