import { Hono } from "hono";
import { installPoolRoutes, type RouteDependencies } from "./routes";
import { installHealthRoutes, type HealthDependencies } from "./health";
import { reportSafeFault, type SafeFaultCategory } from "../observability/sentry-server";

/** Dependencies shared by production and local compositions. Local controls are installed separately. */
export type AppDependencies = RouteDependencies & HealthDependencies & { authHandler?: (request: Request) => Promise<Response> | Response; authAbuseGuard?: (request: Request) => Promise<Response | null>; spaAssets?: Fetcher; reportFault?: (category: SafeFaultCategory) => void };

const hasReservedPrefix = (pathname: string, prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`);

const isSpaRequest = (request: Request): boolean => {
  const pathname = new URL(request.url).pathname;
  return !hasReservedPrefix(pathname, "/api") && !hasReservedPrefix(pathname, "/internal") && !pathname.startsWith("/health") && !pathname.startsWith("/__");
};

/** Worker HTTP boundary: auth owns account/session endpoints; PoolDO owns pool mutations. */
export function createWorkerApp(dependencies: AppDependencies): Hono {
  const app = new Hono();
  const reportFault = dependencies.reportFault ?? reportSafeFault;
  app.onError((error, c) => {
    reportFault("hono-unhandled-route-failure");
    // Mirrors Hono's default handler so this boundary changes no response contract.
    if ("getResponse" in error && typeof error.getResponse === "function") {
      const response = error.getResponse();
      return c.newResponse(response.body, response);
    }
    console.error(error);
    return c.text("Internal Server Error", 500);
  });
  if (dependencies.authHandler) app.all("/api/auth/*", async (c) => {
    const rejected = await dependencies.authAbuseGuard?.(c.req.raw);
    return rejected ?? dependencies.authHandler!(c.req.raw);
  });
  installPoolRoutes(app, dependencies);
  installHealthRoutes(app, dependencies);
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.notFound((c) => dependencies.spaAssets && isSpaRequest(c.req.raw) ? dependencies.spaAssets.fetch(c.req.raw) : c.json({ code: "NOT_FOUND" }, 404));
  return app;
}
