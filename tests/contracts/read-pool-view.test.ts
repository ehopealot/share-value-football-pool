import { describe, expect, it } from "vitest";
import { ReadPoolView, updatePoolSettingsRequest } from "../../src/contracts/http";

describe("ReadPoolView", () => {
  it("requires explicit lifecycle slots and never accepts legacy season fields", () => {
    const view = {
      commandVersion: "1", pool: { poolId: "pool", slug: "pool", name: "Pool", commissionerId: "owner", signupsOpen: true, maxSideBetMicros: "800000000", commissionerNotice: null, commissionerRules: null },
      activeSeason: null, nextDraftSeason: null, latestClosedSeason: null,
      currentMember: { memberId: "owner", role: "commissioner", seasonBalances: [], hasUnreadBoard: false },
      members: [{ memberId: "owner", displayName: "Owner", role: "commissioner", status: "active" }],
      commissioner: { seasonOrders: [] }
    };
    expect(ReadPoolView.parse(view)).toEqual(view);
    expect(ReadPoolView.parse({ ...view, members: [{ ...view.members[0], email: "owner@example.test" }] }).members[0]?.email).toBe("owner@example.test");
    expect(ReadPoolView.safeParse({ ...view, currentMember: { ...view.currentMember, hasUnreadBoard: undefined } }).success).toBe(false);
    expect(ReadPoolView.safeParse({ ...view, pool: { ...view.pool, commissionerNotice: undefined } }).success).toBe(false);
    expect(ReadPoolView.safeParse({ ...view, pool: { ...view.pool, commissionerRules: undefined } }).success).toBe(false);
    for (const malformed of [
      { ...view, activeSeasonId: null, season: null, orders: [] },
      { ...view, pool: { ...view.pool, unexpected: true } },
      { ...view, currentMember: { ...view.currentMember, unexpected: true } },
      { ...view, members: [{ ...view.members[0], unexpected: true }] },
      { ...view, commissioner: { ...view.commissioner, unexpected: true } }
    ]) expect(ReadPoolView.safeParse(malformed).success).toBe(false);
  });

  it("strictly accepts a bounded commissioner notice setting or an explicit clear", () => {
    expect(updatePoolSettingsRequest.parse({ commissionerNotice: "  Draft starts at noon.  ", idempotencyKey: "notice-set" })).toEqual({ commissionerNotice: "Draft starts at noon.", idempotencyKey: "notice-set" });
    expect(updatePoolSettingsRequest.parse({ commissionerNotice: null, idempotencyKey: "notice-clear" })).toEqual({ commissionerNotice: null, idempotencyKey: "notice-clear" });
    for (const body of [
      { idempotencyKey: "empty" },
      { commissionerNotice: "", idempotencyKey: "blank" },
      { commissionerNotice: "   ", idempotencyKey: "whitespace" },
      { commissionerNotice: "x".repeat(501), idempotencyKey: "overlong" },
      { commissionerNotice: "Notice", idempotencyKey: "unknown", unexpected: true }
    ]) expect(updatePoolSettingsRequest.safeParse(body).success).toBe(false);
  });

  it("strictly accepts bounded commissioner rules or an explicit clear", () => {
    expect(updatePoolSettingsRequest.parse({ commissionerRules: "  Weekly picks are due by Sunday noon.  ", idempotencyKey: "rules-set" })).toEqual({ commissionerRules: "Weekly picks are due by Sunday noon.", idempotencyKey: "rules-set" });
    expect(updatePoolSettingsRequest.parse({ commissionerRules: null, idempotencyKey: "rules-clear" })).toEqual({ commissionerRules: null, idempotencyKey: "rules-clear" });
    for (const body of [
      { commissionerRules: "", idempotencyKey: "blank-rules" },
      { commissionerRules: "   ", idempotencyKey: "whitespace-rules" },
      { commissionerRules: "x".repeat(20001), idempotencyKey: "overlong-rules" },
      { commissionerRules: "Rules", idempotencyKey: "unknown-rules", unexpected: true }
    ]) expect(updatePoolSettingsRequest.safeParse(body).success).toBe(false);
  });
});
