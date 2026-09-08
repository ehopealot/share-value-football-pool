export interface InitializePoolInput {
  poolId: string;
  slug: string;
  creatorId: string;
  creatorName: string;
  poolName: string;
  password: string;
  commandId: string;
}

export interface PoolCommandClient {
  initializePool(input: InitializePoolInput): Promise<{ commandVersion: string }>;
}

/** Internal provenance only; its message remains the existing registry-visible error text. */
export class AuthoritativePoolInitializationError extends Error {}
export class PoolInitializationTransportError extends Error {}
export class PoolInitializationDecodeError extends Error {}
export class PoolInitializationProtocolError extends Error {}
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Pool initialization failed.";

/** Worker-to-DO command transport. Worker routes own creator authentication and entitlement; the DO owns command validation, idempotency, and mutation. */
export class DurablePoolCommandClient implements PoolCommandClient {
  constructor(private readonly pools: DurableObjectNamespace) {}

  async initializePool(input: InitializePoolInput): Promise<{ commandVersion: string }> {
    let response: Response;
    try {
      response = await this.pools.get(this.pools.idFromName(input.poolId)).fetch("https://pool.internal/command", {
        method: "POST",
        body: JSON.stringify({ type: "InitializePool", ...input })
      });
    } catch (error) {
      throw new PoolInitializationTransportError(messageOf(error));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new PoolInitializationDecodeError(messageOf(error));
    }
    if (!response.ok) {
      try {
        // Preserve the original short-circuit branch's body.code property access/coercion.
        const code = (body as { code?: unknown }).code ?? "POOL_INITIALIZATION_FAILED";
        throw new AuthoritativePoolInitializationError(String(code));
      } catch (error) {
        if (error instanceof AuthoritativePoolInitializationError) throw error;
        throw new AuthoritativePoolInitializationError(messageOf(error));
      }
    }
    try {
      // Preserve the prior property-access behavior for null/malformed successful JSON.
      const parsed = body as { commandVersion?: string; code?: string };
      if (!parsed.commandVersion) throw new PoolInitializationProtocolError(parsed.code ?? "POOL_INITIALIZATION_FAILED");
      return { commandVersion: parsed.commandVersion };
    } catch (error) {
      if (error instanceof PoolInitializationProtocolError) throw error;
      throw new PoolInitializationProtocolError(messageOf(error));
    }
  }
}
