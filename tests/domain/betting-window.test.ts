import { describe, expect, it } from "vitest";
import { assertBettingOpen, bettingOpensAt, isBettingOpen, nextWeekStart, weekStartOf } from "../../src/domain/betting-week";

describe("Tuesday Pacific betting window", () => {
  it.each([
    ["2026-09-01T04:00:00.000Z", true], // Midnight Eastern is still Monday in Pacific.
    ["2026-09-01T06:59:59.999Z", true], // Monday 23:59:59 PDT
    ["2026-09-01T07:00:00.000Z", false],
    ["2026-09-01T14:00:00.000Z", false], // 10am Eastern is only 7am Pacific.
    ["2026-09-01T16:59:59.999Z", false],
    ["2026-09-01T17:00:00.000Z", true], // Tuesday 10:00 PDT
    ["2026-09-02T07:00:00.000Z", true],
    ["2026-09-07T19:00:00.000Z", true],
    ["2026-11-03T05:00:00.000Z", true],
    ["2026-11-03T07:59:59.999Z", true], // Monday 23:59:59 PST
    ["2026-11-03T08:00:00.000Z", false],
    ["2026-11-03T15:00:00.000Z", false],
    ["2026-11-03T17:59:59.999Z", false],
    ["2026-11-03T18:00:00.000Z", true], // Tuesday 10:00 PST
    ["2026-03-03T17:59:59.999Z", false],
    ["2026-03-03T18:00:00.000Z", true],
    ["2026-03-10T16:59:59.999Z", false],
    ["2026-03-10T17:00:00.000Z", true]
  ])("at %s betting open is %s", (instant, expected) => {
    expect(isBettingOpen(new Date(instant))).toBe(expected);
    if (expected) expect(() => assertBettingOpen(new Date(instant))).not.toThrow();
    else expect(() => assertBettingOpen(new Date(instant))).toThrow("BETTING_CLOSED");
  });

  it.each([
    ["2026-09-01T16:00:00Z", "2026-09-01T07:00:00.000Z", "2026-09-01T17:00:00.000Z", "2026-09-08T07:00:00.000Z"],
    ["2026-11-03T17:00:00Z", "2026-11-03T08:00:00.000Z", "2026-11-03T18:00:00.000Z", "2026-11-10T08:00:00.000Z"],
    ["2026-03-08T21:00:00Z", "2026-03-03T08:00:00.000Z", "2026-03-03T18:00:00.000Z", "2026-03-10T07:00:00.000Z"]
  ])("keeps midnight PT week identities separate from opening at %s", (instant, start, opens, end) => {
    const date = new Date(instant);
    expect(weekStartOf(date).toISOString()).toBe(start);
    expect(bettingOpensAt(date).toISOString()).toBe(opens);
    expect(nextWeekStart(weekStartOf(date)).toISOString()).toBe(end);
  });
});
