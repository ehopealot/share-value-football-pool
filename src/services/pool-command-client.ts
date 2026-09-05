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

/** Worker-to-DO command transport. Worker routes own creator authentication and entitlement; the DO owns command validation, idempotency, and mutation. */
export class DurablePoolCommandClient implements PoolCommandClient {
  constructor(private readonly pools: DurableObjectNamespace) {}

  async initializePool(input: InitializePoolInput): Promise<{ commandVersion: string }> {
    const response = await this.pools.get(this.pools.idFromName(input.poolId)).fetch("https://pool.internal/command", {
      method: "POST",
      body: JSON.stringify({ type: "InitializePool", ...input })
    });
    const body = await response.json() as { commandVersion?: string; code?: string };
    if (!response.ok || !body.commandVersion) throw new Error(body.code ?? "POOL_INITIALIZATION_FAILED");
    return { commandVersion: body.commandVersion };
  }
}
