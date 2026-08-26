import type { Hono } from "hono";
import type { AppDependencies } from "./app";
import { installLocalTestControls, LocalResponseBarrier, localFixtureControls } from "./test-controls";

export type LocalAppDependencies = Pick<AppDependencies, "db" | "pools"> & {
  projectionServiceToken?: string;
  localMailbox: () => Promise<{ messages: Array<{ kind: "verification" | "password-reset"; to: string; token: string }> }>;
  resetLocalAuthLimiter: () => void;
};

const responseBarrier = new LocalResponseBarrier();

/** Installs deterministic fixture routes only into the loopback local composition. */
export function installLocalAppControls(app: Hono, dependencies: LocalAppDependencies): LocalResponseBarrier {
  app.use("/__local-test/*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return c.json({ code: "NOT_FOUND" }, 404);
    await next();
  });
  const controls = localFixtureControls(dependencies.db, dependencies.pools, dependencies.projectionServiceToken);
  controls.mailbox = dependencies.localMailbox;
  controls.resetAuthLimiter = dependencies.resetLocalAuthLimiter;
  controls.responseBarrier = responseBarrier;
  installLocalTestControls(app, controls);
  return responseBarrier;
}
