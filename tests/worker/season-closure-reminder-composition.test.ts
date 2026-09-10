import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ reminder: vi.fn(), odds: vi.fn(), backup: vi.fn(), notifier: { notifySeasonClosureReminder: vi.fn() } }));
vi.mock("../../src/worker/season-closure-reminder-cron", async (original) => ({ ...await original<object>(), runSeasonClosureReminderCron: mocks.reminder }));
vi.mock("../../src/auth/email-sender", async (original) => ({ ...await original<object>(), createResendPoolNotifier: () => mocks.notifier }));
vi.mock("../../src/worker/cron", () => ({ runOddsCron: mocks.odds }));
vi.mock("../../src/worker/backup-cron", () => ({ backupConfigured: (env: { BACKUPS?: unknown }) => Boolean(env.BACKUPS), runBackupCron: mocks.backup }));
vi.mock("../../src/worker/job-status", () => ({ jobAttemptKey: () => "test-attempt", recordJobStatus: async () => undefined }));
import worker, { type Env } from "../../src/index";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reminder.mockResolvedValue({ attemptedPools: 0, sent: 0 });
  mocks.odds.mockRejectedValue(new Error("odds unavailable"));
  mocks.backup.mockRejectedValue(new Error("backup unavailable"));
});

async function scheduled(env: Partial<Env>) {
  const pending: Promise<unknown>[] = [];
  worker.scheduled!({ scheduledTime: 0 } as ScheduledController, env as Env, { waitUntil: (task: Promise<unknown>) => pending.push(task) } as unknown as ExecutionContext);
  return Promise.allSettled(pending);
}

describe("production reminder cron composition", () => {
  it("does not schedule reminders without both required credentials", async () => {
    await scheduled({ RESEND_API_KEY: "test-only" });
    await scheduled({ SETTLEMENT_SERVICE_TOKEN: "test-only" });
    expect(mocks.reminder).not.toHaveBeenCalled();
  });

  it("runs without odds or backups and does not pass the stale scheduled event time", async () => {
    await scheduled({ RESEND_API_KEY: "test-only", SETTLEMENT_SERVICE_TOKEN: "test-only" });
    expect(mocks.reminder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ notifier: mocks.notifier, adminOrigin: "https://officepool.football" }));
    expect(mocks.odds).not.toHaveBeenCalled();
    expect(mocks.backup).not.toHaveBeenCalled();
  });

  it("keeps the reminder independent of odds and backup failures", async () => {
    const results = await scheduled({ RESEND_API_KEY: "test-only", SETTLEMENT_SERVICE_TOKEN: "test-only", ODDS_API_KEY: "test-only", BACKUPS: {} as R2Bucket });
    expect(mocks.reminder).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "rejected"]);
  });
});
