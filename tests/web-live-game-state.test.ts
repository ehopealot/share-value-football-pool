import { describe, expect, it } from "vitest";
import { hasConfirmedLiveGame, loadLiveGameStates } from "../src/web/live-game-state";
import type { ReadActivity } from "../src/contracts/http";
type Wager = ReadActivity["activity"]["wagers"][number];
const now = Date.parse("2026-09-06T21:00:00Z");
const ticket = (eventId: string, overrides = {}) => ({ status: "open", legs: [{ eventId, eventStartsAt: "2026-09-06T20:00:00Z" }], ...overrides }) as Wager;

describe("live game state", () => {
  it("requires actual live state despite elapsed scheduled kickoff, and fails closed", async () => {
    const wagers = ["delayed", "playing", "finished", "unavailable"].map((id) => ticket(id));
    const result = await loadLiveGameStates(wagers, now, async (id) => {
      if (id === "unavailable") throw new Error("offline");
      return { state: id === "playing" ? "live" : id === "finished" ? "final" : "pregame" };
    });
    expect(wagers.map((wager) => hasConfirmedLiveGame(wager, now, result.liveEventIds))).toEqual([false, true, false, false]);
    expect(result.failures).toBe(1);
  });
  it("deduplicates requests and excludes lost, graded, future and hidden selections", async () => {
    const wagers = [ticket("playing"), ticket("playing"), ticket("lost", { status: "lost" }), ticket("hidden", { legs: undefined }), ticket("graded", { legs: [{ eventId: "graded", eventStartsAt: "2026-09-06T20:00:00Z", grade: "win" }] }), ticket("future", { legs: [{ eventId: "future", eventStartsAt: "2026-09-07T20:00:00Z" }] })];
    const calls: string[] = [];
    const result = await loadLiveGameStates(wagers, now, async (id) => { calls.push(id); return { state: "live" }; });
    expect(calls).toEqual(["playing"]);
    expect(wagers.map((wager) => hasConfirmedLiveGame(wager, now, result.liveEventIds))).toEqual([true, true, false, false, false, false]);
  });
  it("bounds concurrent requests", async () => {
    let pending = 0; let peak = 0;
    await loadLiveGameStates(Array.from({ length: 12 }, (_, i) => ticket(String(i))), now, async () => {
      pending++; peak = Math.max(peak, pending);
      await new Promise((resolve) => setTimeout(resolve, 1));
      pending--; return { state: "live" };
    });
    expect(peak).toBe(3);
  });
});
