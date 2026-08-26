import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PoolCommand } from "../../src/durable/pool-commands";
import { drainOutbox, enqueueOutbox, type PoolOutboxMessage } from "../../src/durable/outbox";
import { poolOutboxMessage } from "../../src/contracts/commands";

const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
const send = async (slug: string, command: any): Promise<Record<string, unknown>> => {
  const stub = pools.get(pools.idFromName(slug));
  const post = async (value: unknown) => (await stub.fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(value) })).json() as Promise<Record<string, unknown>>;
  if (command.type !== "PlaceStraightWager" && command.type !== "PlaceTeaserWager") return post(command);
  const quoteKey = `quote:${command.commandId}`;
  const view = await post({ type: "ReadPoolView", commandId: `version:${quoteKey}`, actorId: command.actorId });
  const normalize = (leg: any) => ({ ...leg, adjustedLine: leg.adjustedLine ?? leg.originalLine, homeTeam: leg.homeTeam ?? "Home", awayTeam: leg.awayTeam ?? "Away" });
  const projection = { quoteKey, ownerMemberId: command.actorId, commandVersion: String(view.commandVersion), fingerprint: `fixture:${quoteKey}`, wagerId: command.wagerId, actorId: command.actorId, seasonId: command.seasonId, riskMicros: command.riskMicros, acceptedOdds: command.acceptedOdds, rulesetVersion: command.rulesetVersion, ...(command.type === "PlaceStraightWager" ? { leg: normalize(command.leg) } : { teaserPoints: command.teaserPoints, legs: command.legs.map(normalize) }) };
  const quote = await post({ type: command.type === "PlaceStraightWager" ? "QuoteStraightWager" : "QuoteTeaserWager", commandId: quoteKey, actorId: command.actorId, identity: { actorId: command.actorId, quoteKey, fingerprint: projection.fingerprint }, projection });
  if (quote.code) return quote;
  return post({ type: command.type, commandId: command.commandId, actorId: command.actorId, wagerId: command.wagerId, quoteKey, quotedCommandVersion: String(quote.commandVersion), seasonId: quote.seasonId, riskMicros: quote.riskMicros, acceptedOdds: quote.acceptedOdds, rulesetVersion: quote.rulesetVersion, ...(command.type === "PlaceStraightWager" ? { leg: quote.leg } : { teaserPoints: quote.teaserPoints, legs: quote.legs }) });
};
const stateFor = <T>(slug: string, callback: (state: DurableObjectState) => T) => runInDurableObject(pools.get(pools.idFromName(slug)), (_instance, state) => callback(state));
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

async function poolWithHiddenTicket(slug = `privacy-${crypto.randomUUID()}`) {
  await send(slug, { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Privacy", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
  await send(slug, { type: "JoinPool", commandId: "member", actorId: "member", displayName: "Member", password: "correct-password" });
  await send(slug, { type: "JoinPool", commandId: "viewer", actorId: "viewer", displayName: "Viewer", password: "correct-password" });
  await send(slug, { type: "CreateSeason", commandId: "draft", actorId: "owner", seasonId: "s1", label: "2026" });
  await send(slug, { type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "s1" });
  const quote = await send(slug, { type: "QuoteShareOrder", commandId: "quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000" });
  await send(slug, { type: "ExecuteShareOrder", commandId: "fund", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000", quote: { priceMicros: String(quote.priceMicros), commandVersion: String(quote.commandVersion) }, reason: "fund member" });
  expect(await send(slug, { type: "PlaceStraightWager", commandId: "place", actorId: "member", wagerId: "w1", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: "private-event", league: "nfl", canonicalBook: "DraftKings", retrievedAt: new Date().toISOString(), policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "offer-v1", canonicalOfferProof: { offerId: "private-event:spread:home", eventId: "private-event", offerVersion: "offer-v1", canonicalBook: "DraftKings", market: "spread", selection: "home", odds: -110, line: -3.5 }, market: "spread", selection: "home", originalLine: -3.5, originalOdds: -110, eventStartsAt: future } })).toMatchObject({ wagerId: "w1" });
  return slug;
}

describe("PoolDO privacy and committed outbox", () => {
  it("redacts every unstarted selection for nonowners, including the commissioner", async () => {
    const slug = await poolWithHiddenTicket();
    const owner = await send(slug, { type: "ReadWagers", commandId: "owner-read", actorId: "member" });
    expect(JSON.stringify(owner)).toContain("private-event");
    for (const actorId of ["owner", "viewer"]) {
      const view = await send(slug, { type: "ReadWagers", commandId: `read-${actorId}-${crypto.randomUUID()}`, actorId });
      const text = JSON.stringify(view);
      expect(text).not.toMatch(/private-event|DraftKings|spread|home|-3\.5|legs|riskMicros/);
    }
    await stateFor(slug, (state) => state.storage.sql.exec("UPDATE wager_leg SET event_starts_at = '1970-01-01T00:00:00.000Z' WHERE event_id = 'private-event'"));
    expect(JSON.stringify(await send(slug, { type: "ReadWagers", commandId: "post-start", actorId: "viewer" }))).toContain("private-event");
    const replayedRead: any = { type: "ReadWagers", commandId: "suspended-read", actorId: "viewer" };
    expect(await send(slug, replayedRead)).toMatchObject({ commandVersion: expect.any(String) });
    await send(slug, { type: "SuspendMember", commandId: "suspend-viewer", actorId: "owner", memberId: "viewer" });
    expect(await send(slug, replayedRead)).toMatchObject({ code: "SUSPENDED" });
  }, 30_000);

  it("reveals only started teaser legs to nonowners", async () => {
    const slug = await poolWithHiddenTicket();
    // The authoritative privacy fixture executes one million shares above. This separate,
    // freshly quoted order funds this independent second wager without changing that execution.
    const quote = await send(slug, { type: "QuoteShareOrder", commandId: "teaser-funding-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000" });
    await send(slug, { type: "ExecuteShareOrder", commandId: "teaser-funding", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000", quote: { priceMicros: String(quote.priceMicros), commandVersion: String(quote.commandVersion) }, reason: "fund teaser" });
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const teaserLeg = (eventId: string, line: number) => ({ eventId, league: "nfl" as const, canonicalBook: "DraftKings", retrievedAt: new Date().toISOString(), policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "offer-v1", canonicalOfferProof: { offerId: `${eventId}:spread:home`, eventId, offerVersion: "offer-v1", canonicalBook: "DraftKings", market: "spread" as const, selection: "home" as const, odds: -110, line }, market: "spread" as const, selection: "home" as const, originalLine: line, originalOdds: -110, adjustedLine: line + 6, eventStartsAt: startsAt });
    await send(slug, { type: "PlaceTeaserWager", commandId: "mixed-teaser", actorId: "member", wagerId: "mixed", seasonId: "s1", riskMicros: "1000000", acceptedOdds: -120, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: [teaserLeg("started-leg", -6), teaserLeg("future-leg", -3)] });
    await stateFor(slug, (state) => state.storage.sql.exec("UPDATE wager_leg SET event_starts_at = '1970-01-01T00:00:00.000Z' WHERE event_id = 'started-leg'"));
    const view = JSON.stringify(await send(slug, { type: "ReadWagers", commandId: "mixed-read", actorId: "viewer" }));
    expect(view).toContain("started-leg");
    expect(view).not.toContain("future-leg");
  }, 30_000);

  it("emits only command-discriminated repair identities", async () => {
    const slug = await poolWithHiddenTicket();
    const quote = await send(slug, { type: "QuoteShareOrder", commandId: "extra-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000" });
    const executed = await send(slug, { type: "ExecuteShareOrder", commandId: "extra-fund", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000", quote: { priceMicros: String(quote.priceMicros), commandVersion: String(quote.commandVersion) }, reason: "extra funding" });
    await send(slug, { type: "ReverseShareOrder", commandId: "reverse-fund", actorId: "owner", orderId: String(executed.orderId), reason: "correction" });
    await send(slug, { type: "CloseSeason", commandId: "close-season", actorId: "owner", seasonId: "s1", reason: "commissioner closure" });
    const events = await stateFor(slug, (state) => [...state.storage.sql.exec<{ id: string; event_type: string; version: string; payload_json: string }>("SELECT id, event_type, version, payload_json FROM outbox")]);
    const parsed = events.map((event) => poolOutboxMessage.safeParse({ eventId: event.id, eventType: event.event_type, version: event.version, payload: JSON.parse(event.payload_json) }));
    expect(parsed.every((event) => event.success)).toBe(true);
    expect(parsed.some((event) => event.success && event.data.eventType === "CommandApplied" && event.data.payload.commandType === "ExecuteShareOrder" && event.data.payload.orderId === String(executed.orderId))).toBe(true);
    expect(parsed.some((event) => event.success && event.data.eventType === "CommandApplied" && event.data.payload.commandType === "ReverseShareOrder" && event.data.payload.orderId === String(executed.orderId) && event.data.payload.memberId === "member" && event.data.payload.seasonId === "s1")).toBe(true);
    expect(parsed.some((event) => event.success && event.data.eventType === "SeasonClosed" && event.data.payload.seasonId === "s1" && event.data.payload.closeReason === "commissioner_closed")).toBe(true);
    expect(poolOutboxMessage.safeParse({ eventId: "incomplete", eventType: "CommandApplied", version: "1", payload: { poolId: slug, actorId: "owner", commandId: "missing-order", commandType: "ReverseShareOrder", seasonId: "s1", memberId: "member" } }).success).toBe(false);
    expect(poolOutboxMessage.safeParse({ eventId: "unknown", eventType: "CommandApplied", version: "1", payload: { poolId: slug, actorId: "owner", commandId: "unknown", commandType: "UnexpectedCommand" } }).success).toBe(false);
  }, 30_000);

  it("keeps a committed event after Queue failure and delivers it once on recovery", async () => {
    const slug = await poolWithHiddenTicket();
    const sent: PoolOutboxMessage[] = [];
    let fail = true;
    const queue = { send: async (message: PoolOutboxMessage) => { if (fail) throw new Error("queue offline"); sent.push(message); } } as unknown as Queue<PoolOutboxMessage>;
    await stateFor(slug, async (state) => {
      await state.storage.transaction(async () => enqueueOutbox(state.storage.sql, { eventId: "recovery-event", eventType: "CommandApplied", version: "99", payload: { poolId: slug, actorId: "owner", commandId: "recovery", commandType: "JoinPool", memberId: "member" } }));
      await drainOutbox(state, queue);
      expect([...state.storage.sql.exec("SELECT delivered_at, attempts FROM outbox WHERE version = '99'")][0]).toEqual({ delivered_at: null, attempts: 1 });
      fail = false;
      state.storage.sql.exec("UPDATE outbox SET next_attempt_at = ? WHERE version = '99'", new Date(0).toISOString());
      await drainOutbox(state, queue);
      expect(sent).toHaveLength(1);
      expect([...state.storage.sql.exec("SELECT delivered_at, attempts FROM outbox WHERE version = '99'")][0]).toEqual({ delivered_at: expect.any(String), attempts: 2 });
    });
  }, 30_000);

  it("retains invalid and out-of-order producer rows while rejecting duplicate identities", async () => {
    const slug = await poolWithHiddenTicket();
    await stateFor(slug, async (state) => {
      state.storage.sql.exec("INSERT INTO outbox (id, event_type, version, payload_json, attempts, next_attempt_at, created_at) VALUES ('invalid', 'SettlementApplied', '10', '{}', 0, ?, ?)", new Date(0).toISOString(), new Date().toISOString());
      const later: PoolOutboxMessage = { eventId: "out-of-order-2", eventType: "CommandApplied", version: "2", payload: { poolId: slug, actorId: "owner", commandId: "later", commandType: "JoinPool", memberId: "member" } };
      const earlier: PoolOutboxMessage = { ...later, eventId: "out-of-order-1", version: "1", payload: { ...later.payload, commandId: "earlier" } };
      enqueueOutbox(state.storage.sql, later);
      enqueueOutbox(state.storage.sql, earlier);
      expect(() => enqueueOutbox(state.storage.sql, later)).toThrow();
      const sent: PoolOutboxMessage[] = [];
      const queue = { send: async (message: PoolOutboxMessage) => sent.push(message) } as unknown as Queue<PoolOutboxMessage>;
      await drainOutbox(state, queue);
      expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ eventId: "out-of-order-1", version: "1" }), expect.objectContaining({ eventId: "out-of-order-2", version: "2" })]));
      expect(sent).not.toContainEqual(expect.objectContaining({ eventId: "invalid" }));
      expect([...state.storage.sql.exec("SELECT delivered_at, attempts, last_error FROM outbox WHERE id = 'invalid'")][0]).toEqual({ delivered_at: null, attempts: 5, last_error: "INVALID_OUTBOX_EVENT" });
    });
  }, 30_000);
});
