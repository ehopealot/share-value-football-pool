import { internalSettlementCommand } from "../contracts/commands";

type InternalSettlementEnv = { POOL_DO: DurableObjectNamespace; SETTLEMENT_SERVICE_TOKEN?: string };

export async function handleInternalSettlement(request: Request, env: InternalSettlementEnv): Promise<Response | null> {
  const settlementPath = new URL(request.url).pathname.match(/^\/internal\/pools\/([^/]+)\/settle$/);
  if (!settlementPath) return null;
  const token = request.headers.get("x-settlement-service-token");
  const command = internalSettlementCommand.safeParse({ poolId: settlementPath[1], serviceToken: token });
  if (request.method !== "POST" || request.headers.has("origin") || !env.SETTLEMENT_SERVICE_TOKEN || !command.success || token !== env.SETTLEMENT_SERVICE_TOKEN) return new Response("Not found", { status: 404 });
  return env.POOL_DO.get(env.POOL_DO.idFromName(command.data.poolId)).fetch("https://pool.internal/internal/settle", { method: "POST", headers: { "x-settlement-service-token": token } });
}
