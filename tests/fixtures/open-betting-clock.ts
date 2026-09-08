import { afterEach, beforeEach, vi } from "vitest";

/** Pins betting fixtures inside a known-open Pacific betting window without faking timers. */
export function useOpenBettingClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T17:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());
}
