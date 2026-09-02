import { describe, expect, it } from "vitest";
import { ReadPoolView } from "../../src/contracts/http";

describe("ReadPoolView", () => {
  it("requires explicit lifecycle slots and never accepts legacy season fields", () => {
    const view = {
      commandVersion: "1", pool: { poolId: "pool", slug: "pool", name: "Pool", commissionerId: "owner", signupsOpen: true, maxSideBetMicros: "800000000" },
      activeSeason: null, nextDraftSeason: null, latestClosedSeason: null,
      currentMember: { memberId: "owner", role: "commissioner", seasonBalances: [], hasUnreadBoard: false },
      members: [{ memberId: "owner", displayName: "Owner", role: "commissioner", status: "active" }],
      commissioner: { seasonOrders: [] }
    };
    expect(ReadPoolView.parse(view)).toEqual(view);
    expect(ReadPoolView.safeParse({ ...view, currentMember: { ...view.currentMember, hasUnreadBoard: undefined } }).success).toBe(false);
    for (const malformed of [
      { ...view, activeSeasonId: null, season: null, orders: [] },
      { ...view, pool: { ...view.pool, unexpected: true } },
      { ...view, currentMember: { ...view.currentMember, unexpected: true } },
      { ...view, members: [{ ...view.members[0], unexpected: true }] },
      { ...view, commissioner: { ...view.commissioner, unexpected: true } }
    ]) expect(ReadPoolView.safeParse(malformed).success).toBe(false);
  });
});
