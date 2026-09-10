import { describe, expect, it } from "vitest";
import { formatOpsTime, jobSignal, scheduleSignal } from "../src/web/ops-presentation";

const now = Date.parse("2026-09-10T12:00:00.000Z");

describe("operations timestamp presentation", () => {
  it("shows relative time and an exact local time with timezone", () => {
    const value = "2026-09-10T11:58:00.000Z";
    expect(formatOpsTime(value, now)).toEqual({
      dateTime: value,
      relative: "2 minutes ago",
      exact: new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(value))
    });
  });

  it.each([
    ["2026-09-10T12:02:00.000Z", "in 2 minutes"],
    ["2026-09-10T11:59:30.000Z", "30 seconds ago"],
    ["2026-09-10T10:00:00.000Z", "2 hours ago"],
    ["2026-09-08T12:00:00.000Z", "2 days ago"],
    ["2026-09-10T12:00:00.000Z", "now"]
  ])("formats %s relative to the snapshot", (value, relative) => {
    expect(formatOpsTime(value, now)?.relative).toBe(relative);
  });

  it.each([null, "", "invalid date"])("does not invent a time for %s", (value) => {
    expect(formatOpsTime(value, now)).toBeNull();
  });
});

describe("job evidence signals", () => {
  it.each([
    ["success", "current", "good", "Recent check OK"],
    ["not_due", "current", "good", "Recent check OK"],
    ["success", "stale", "attention", "Needs attention"],
    ["not_due", "stale", "attention", "Needs attention"],
    ["failed", "current", "bad", "Failed"],
    ["failed", "stale", "bad", "Failed"],
    ["unknown", "current", "neutral", "Unknown"],
    ["superseded", "current", "neutral", "Unknown"],
    ["new_status", "current", "neutral", "Unknown"],
    ["success", "unknown", "neutral", "Unknown"]
  ] as const)("classifies %s / %s without treating freshness as success", (status, freshness, tone, label) => {
    expect(jobSignal(status, freshness)).toEqual({ tone, label });
  });
});

describe("scheduling observations", () => {
  it("only calls passed times attention-worthy, not failed", () => {
    expect(scheduleSignal("2026-09-10T11:59:00.000Z", now)).toEqual({ tone: "attention", label: "Time passed" });
    expect(scheduleSignal("2026-09-10T12:00:00.000Z", now).tone).toBe("attention");
    expect(scheduleSignal("2026-09-10T12:01:00.000Z", now)).toEqual({ tone: "neutral", label: "Scheduled" });
    expect(scheduleSignal(null, now)).toEqual({ tone: "neutral", label: "None observed" });
    expect(scheduleSignal("invalid", now)).toEqual({ tone: "neutral", label: "Unknown" });
  });
});
