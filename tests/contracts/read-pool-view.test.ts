import { describe, expect, it } from "vitest";
import { ReadPoolView } from "../../src/contracts/http";

describe("ReadPoolView", () => {
  it("requires explicit lifecycle slots and never accepts legacy season fields", () => {
    const view = {
      commandVersion: "1", pool: { poolId: "pool", slug: "pool", name: "Pool", commissionerId: "owner", signupsOpen: true },
      activeSeason: null, nextDraftSeason: null, latestClosedSeason: null,
      currentMember: { memberId: "owner", role: "commissioner", seasonBalances: [] },
      members: [{ memberId: "owner", displayName: "Owner", role: "commissioner", status: "active" }],
      commissioner: { seasonOrders: [] }
    };
    expect(ReadPoolView.parse(view)).toEqual(view);
    expect(ReadPoolView.safeParse({ ...view, activeSeasonId: null, season: null, orders: [] }).success).toBe(true);
  });
});
