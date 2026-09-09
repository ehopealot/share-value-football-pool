import { describe, expect, it } from "vitest";
import { ALL_WEEKS_VALUE, selectedWeekOrCurrent, wagerWeekOptions } from "../src/web/week-picker-presentation";

const currentWeek = "2026-09-08T07:00:00.000Z";

describe("week picker presentation", () => {
  it("puts the current week in the options even without wagers", () => {
    expect(wagerWeekOptions([], currentWeek)).toEqual([currentWeek]);
    expect(wagerWeekOptions(["2026-09-01T07:00:00.000Z"], currentWeek)).toEqual([currentWeek, "2026-09-01T07:00:00.000Z"]);
  });

  it("defaults to the current week and uses an explicit All weeks selection", () => {
    const options = wagerWeekOptions(["2026-09-01T07:00:00.000Z"], currentWeek);
    expect(selectedWeekOrCurrent("", options, currentWeek)).toBe(currentWeek);
    expect(selectedWeekOrCurrent("2026-09-01T07:00:00.000Z", options, currentWeek)).toBe("2026-09-01T07:00:00.000Z");
    expect(selectedWeekOrCurrent(ALL_WEEKS_VALUE, options, currentWeek)).toBeUndefined();
  });
});
