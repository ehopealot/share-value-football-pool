import { describe, expect, it, vi } from "vitest";
import { canonicalizeWagerQuote, revalidateWagerOffers } from "../../src/worker/offer-quotes";
import { placeWager } from "../../src/durable/wager-commands";
import type { PoolCommand } from "../../src/durable/pool-commands";

type Placement = Extract<PoolCommand, { type: "PlaceStraightWager" | "PlaceTeaserWager" | "PlaceParlayWager" }>;
// These paths must reject the closed window before accessing funds or offers.
const command = (type: Placement["type"]) => ({ type, riskMicros: "1000000", leg: {}, legs: [{}, {}] } as unknown as Placement);

describe("betting-window authority", () => {
  it.each(["PlaceStraightWager", "PlaceTeaserWager", "PlaceParlayWager"] as const)("rejects %s quotes, revalidation and accounting before 10am ET", async (type) => {
    const now = new Date("2026-09-01T13:59:59.999Z");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const prepare = vi.fn(() => { throw new Error("OFFER_READ_REACHED"); });
    const db = { prepare } as unknown as D1Database;
    const exec = vi.fn(() => []);
    await expect(canonicalizeWagerQuote(db, command(type), now)).rejects.toThrow("BETTING_CLOSED");
    await expect(revalidateWagerOffers(db, command(type), now)).rejects.toThrow("BETTING_CLOSED");
    expect(() => placeWager({ exec }, command(type))).toThrow("BETTING_CLOSED");
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["2026-09-01T03:59:59.999Z", "2026-09-01T14:00:00.000Z", "2026-11-03T15:00:00.000Z"])("allows normal validation at %s", async (instant) => {
    const now = new Date(instant);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const db = { prepare: () => { throw new Error("OFFER_READ_REACHED"); } } as unknown as D1Database;
    await expect(canonicalizeWagerQuote(db, command("PlaceStraightWager"), now)).rejects.toThrow("OFFER_READ_REACHED");
    await expect(revalidateWagerOffers(db, command("PlaceStraightWager"), now)).rejects.toThrow("OFFER_READ_REACHED");
    expect(() => placeWager({ exec: () => [] }, command("PlaceStraightWager"))).toThrow("SEASON_NOT_ACTIVE");
  });
});
