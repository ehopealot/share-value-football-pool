import type { PoolCommand } from "../durable/pool-commands";
import type { PoolRegistry } from "../services/pool-registry";
import { revalidateWagerOffers } from "./offer-quotes";
import { reportSafeFault, type SafeFaultCategory } from "../observability/sentry-server";

/** Preserves authoritative PoolDO recovery details for the HTTP boundary. */
export class PoolCommandError extends Error {
  constructor(code: string, readonly details: Record<string, unknown> = {}) { super(code); }
}

/** Internal marker prevents route-level duplicate reporting after a router fault is flattened. */
export class ReportedWorkerFault extends Error {
  constructor(message: string) { super(message); }
}

const reported = (category: SafeFaultCategory, outwardCode = "POOL_UNAVAILABLE") => {
  reportSafeFault(category);
  return new ReportedWorkerFault(outwardCode);
};
const expectedRevalidationFailure = (error: unknown) => error instanceof Error && ["LINE_CHANGED", "MARKET_UNAVAILABLE", "MARKET_LOCKED", "MARKET_STALE", "BETTING_CLOSED"].includes(error.message);

/** Resolves a D1 discovery record then forwards an already-authenticated command to its authoritative PoolDO. */
export class PoolCommandRouter {
  constructor(private readonly registry: PoolRegistry, private readonly pools: DurableObjectNamespace, private readonly db?: D1Database) {}

  async send(slug: string, command: PoolCommand): Promise<Record<string, unknown>> {
    let record: Awaited<ReturnType<PoolRegistry["getBySlug"]>>;
    try { record = await this.registry.getBySlug(slug); }
    catch { throw reported("router-registry-lookup-failure"); }
    if (!record || record.status !== "ready") throw new Error("POOL_NOT_AVAILABLE");
    if (command.type === "PlaceStraightWager" || command.type === "PlaceTeaserWager" || command.type === "PlaceParlayWager") {
      if (!this.db) throw new Error("MARKET_UNAVAILABLE");
      try { await revalidateWagerOffers(this.db, command); }
      catch (error) {
        if (expectedRevalidationFailure(error)) throw error;
        throw reported("router-wager-revalidation-failure", error instanceof Error ? error.message : "COMMAND_FAILED");
      }
    }
    let response: Response;
    try {
      response = await this.pools.get(this.pools.idFromName(record.poolId)).fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify(command) });
    } catch (error) {
      throw reported("router-do-dispatch-failure");
    }
    // A 5xx can follow a committed command; never expose it as a terminal client failure.
    if (response.status >= 500) throw reported("router-do-dispatch-failure");
    let decoded: unknown;
    try { decoded = await response.json(); }
    catch { throw reported("router-do-decode-failure"); }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw reported("router-do-decode-failure");
    const body = decoded as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof body.code === "string" ? body.code : "POOL_UNAVAILABLE";
      throw new PoolCommandError(code, { ...body, code });
    }
    return body;
  }
}
