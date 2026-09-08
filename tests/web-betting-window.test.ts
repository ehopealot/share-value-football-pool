import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { useBettingWindow } from "../src/web/betting-window";
import { ApiError, commandOutcome, errorMessage } from "../src/web/api";

const hooks = vi.hoisted(() => ({ value: undefined as Date | undefined, effect: undefined as (() => () => void) | undefined }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: () => Date) => [hooks.value ??= initial(), (value: Date) => { hooks.value = value; }],
  useEffect: (effect: () => () => void) => { hooks.effect = effect; }
}));
afterEach(() => { hooks.value = undefined; hooks.effect = undefined; vi.unstubAllGlobals(); });
const setup = (instant: string) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(instant));
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", new EventTarget());
};

describe("betting window UI", () => {
  it("updates an open page at midnight and 10am PT without a reload", () => {
    setup("2026-09-08T06:59:59.000Z");
    expect(useBettingWindow()).toMatchObject({ open: true, currentWeek: "2026-09-01T07:00:00.000Z" });
    let cleanup = hooks.effect!();
    vi.advanceTimersByTime(1000);
    expect(useBettingWindow()).toMatchObject({ open: false, currentWeek: "2026-09-08T07:00:00.000Z" });
    cleanup(); cleanup = hooks.effect!();
    vi.advanceTimersByTime(10 * 60 * 60 * 1000);
    expect(useBettingWindow().open).toBe(true);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes when a sleeping tab regains focus", () => {
    setup("2026-11-03T17:00:00.000Z");
    expect(useBettingWindow().open).toBe(false);
    const cleanup = hooks.effect!();
    vi.setSystemTime(new Date("2026-11-03T18:00:00.000Z"));
    window.dispatchEvent(new Event("focus"));
    expect(useBettingWindow().open).toBe(true);
    cleanup();
  });

  it("provides a terminal, actionable server error", () => {
    const error = new ApiError("BETTING_CLOSED", 400);
    expect(commandOutcome(error)).toBe("terminal");
    expect(errorMessage(error)).toBe("Betting opens Tuesday at 10:00 a.m. PT. The betting week still ends Monday at midnight PT.");
  });

  it("uses the live window on the board and both builders without blocking unknown-placement retries", () => {
    const source = (name: string) => readFileSync(new URL(`../src/web/pages/${name}.tsx`, import.meta.url), "utf8");
    const odds = source("OddsPage");
    expect(odds).toContain("useBettingWindow()");
    expect(odds).toContain("selectionDisabled={!bettingOpen || parlayTransferPending}");
    expect(odds).toContain("disabled={!bettingOpen || parlayTransferPending || !view?.activeSeason?.id || !!riskError}");
    for (const name of ["TeaserPage", "ParlayPage"]) {
      expect(source(name)).toContain("useBettingWindow()");
      expect(source(name)).toContain("BETTING_CLOSED_MESSAGE");
      expect(source(name)).toContain("disabled={pending || (!bettingOpen && !placementUnknown)}");
    }
  });
});
