import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ report: vi.fn(), sweep: vi.fn(), odds: vi.fn(), factory: vi.fn(), configured: true }));
vi.mock("../../src/services/operational-alerts", async (original) => ({ ...await original<object>(), createOperationalAlerts: (env: unknown) => { mocks.factory(env); return mocks.configured ? { report: mocks.report } : undefined; } }));
vi.mock("../../src/worker/settlement-alert-cron", () => ({ runSettlementAlertCron: mocks.sweep }));
vi.mock("../../src/worker/cron", () => ({ runOddsCron: mocks.odds }));
vi.mock("../../src/worker/job-status", () => ({ jobAttemptKey: () => "test-job", recordJobStatus: async () => undefined }));
import worker, { type Env } from "../../src/index";
import { PoolDO as LocalPoolDO } from "../../src/durable/local-pool-do";

beforeEach(() => {
  vi.clearAllMocks(); mocks.configured = true;
  mocks.report.mockResolvedValue(undefined); mocks.sweep.mockResolvedValue({ inspected: 0 });
  mocks.odds.mockRejectedValue(new Error("provider failed"));
});
async function scheduled(env: Partial<Env>) {
  const tasks: Promise<unknown>[] = [];
  worker.scheduled!({ scheduledTime: Date.now() } as ScheduledController, env as Env, { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext);
  let drained = 0;
  while (drained < tasks.length) { const batch = tasks.slice(drained); drained = tasks.length; await Promise.allSettled(batch); }
}
describe("production failure alert composition", () => {
  it("strips live mail credentials from the local Durable Object identity", () => {
    const state = { storage: { sql: { exec: () => [] }, transactionSync: (callback: () => unknown) => callback() } } as unknown as DurableObjectState;
    const env = { RESEND_API_KEY: "must-not-send", OPS_OPERATOR_USER_IDS: "operator" };
    new LocalPoolDO(state, env);
    expect(mocks.factory).toHaveBeenCalledWith({ ...env, RESEND_API_KEY: undefined });
    expect(env.RESEND_API_KEY).toBe("must-not-send");
  });
  it("alerts on odds failure without preventing the independent overdue sweep", async () => {
    await scheduled({ ODDS_API_KEY: "test-only", OPS_SERVICE_TOKEN: "test-only" });
    expect(mocks.report).toHaveBeenCalledWith({ kind: "odds_update", scope: "global" });
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
  });
  it("runs the overdue sweep without odds or backup configuration and reports inspection failure", async () => {
    mocks.sweep.mockRejectedValueOnce(new Error("D1 failed"));
    await scheduled({ OPS_SERVICE_TOKEN: "test-only" });
    expect(mocks.odds).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledWith({ kind: "settlement_check", scope: "global" });
  });
  it("disables the sweep without mail recipients or its read-only credential", async () => {
    mocks.configured = false;
    await scheduled({ OPS_SERVICE_TOKEN: "test-only" });
    mocks.configured = true;
    await scheduled({});
    expect(mocks.sweep).not.toHaveBeenCalled();
  });
});
