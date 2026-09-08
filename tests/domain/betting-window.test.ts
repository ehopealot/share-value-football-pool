import { describe, expect, it } from "vitest";
import { assertBettingOpen, bettingOpensAt, isBettingOpen, nextWeekStart, weekStartOf } from "../../src/domain/betting-week";

describe("Tuesday betting window", () => {
  it.each([
    ["2026-09-01T03:59:59.999Z", true], // Monday 23:59:59 EDT
    ["2026-09-01T04:00:00.000Z", false],
    ["2026-09-01T13:59:59.999Z", false],
    ["2026-09-01T14:00:00.000Z", true], // Tuesday 10:00 EDT
    ["2026-09-02T04:00:00.000Z", true],
    ["2026-09-07T16:00:00.000Z", true],
    ["2026-11-03T04:59:59.999Z", true], // Monday 23:59:59 EST
    ["2026-11-03T05:00:00.000Z", false],
    ["2026-11-03T14:59:59.999Z", false],
    ["2026-11-03T15:00:00.000Z", true], // Tuesday 10:00 EST
    ["2026-03-03T14:59:59.999Z", false],
    ["2026-03-03T15:00:00.000Z", true],
    ["2026-03-10T13:59:59.999Z", false],
    ["2026-03-10T14:00:00.000Z", true]
  ])("at %s betting open is %s", (instant, expected) => {
    expect(isBettingOpen(new Date(instant))).toBe(expected);
    if (expected) expect(() => assertBettingOpen(new Date(instant))).not.toThrow();
    else expect(() => assertBettingOpen(new Date(instant))).toThrow("BETTING_CLOSED");
  });

  it.each([
    ["2026-09-01T13:00:00Z", "2026-09-01T04:00:00.000Z", "2026-09-01T14:00:00.000Z", "2026-09-08T04:00:00.000Z"],
    ["2026-11-03T14:00:00Z", "2026-11-03T05:00:00.000Z", "2026-11-03T15:00:00.000Z", "2026-11-10T05:00:00.000Z"],
    ["2026-03-08T18:00:00Z", "2026-03-03T05:00:00.000Z", "2026-03-03T15:00:00.000Z", "2026-03-10T04:00:00.000Z"]
  ])("keeps midnight week identities separate from opening at %s", (instant, start, opens, end) => {
    const date = new Date(instant);
    expect(weekStartOf(date).toISOString()).toBe(start);
    expect(bettingOpensAt(date).toISOString()).toBe(opens);
    expect(nextWeekStart(weekStartOf(date)).toISOString()).toBe(end);
  });
});
