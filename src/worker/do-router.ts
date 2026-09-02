import type { PoolCommand } from "../durable/pool-commands";
import type { PoolRegistry } from "../services/pool-registry";
import { revalidateWagerOffers } from "./offer-quotes";

/** Preserves authoritative PoolDO recovery details for the HTTP boundary. */
export class PoolCommandError extends Error {
  constructor(code: string, readonly details: Record<string, unknown> = {}) { super(code); }
}

/** Resolves a D1 discovery record then forwards an already-authenticated command to its authoritative PoolDO. */
export class PoolCommandRouter {
  constructor(private readonly registry: PoolRegistry, private readonly pools: DurableObjectNamespace, private readonly db?: D1Database) {}

  async send(slug: string, command: PoolCommand): Promise<Record<string, unknown>> {
    const record = await this.registry.getBySlug(slug);
    if (!record || record.status !== "ready") throw new Error("POOL_NOT_AVAILABLE");
    if (command.type === "PlaceStraightWager" || command.type === "PlaceTeaserWager") {
      if (!this.db) throw new Error("MARKET_UNAVAILABLE");
      await revalidateWagerOffers(this.db, command);
    }
    let response: Response;
    try {
      response = await this.pools.get(this.pools.idFromName(record.poolId)).fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify(command) });
    } catch {
      throw new Error("POOL_UNAVAILABLE");
    }
    // A 5xx can follow a committed command; never expose it as a terminal client failure.
    if (response.status >= 500) throw new Error("POOL_UNAVAILABLE");
    let decoded: unknown;
    try { decoded = await response.json(); }
    catch { throw new Error("POOL_UNAVAILABLE"); }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("POOL_UNAVAILABLE");
    const body = decoded as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof body.code === "string" ? body.code : "POOL_UNAVAILABLE";
      throw new PoolCommandError(code, { ...body, code });
    }
    return body;
  }
}
