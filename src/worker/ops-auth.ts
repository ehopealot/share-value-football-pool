import type { Context } from "hono";
import type { AuthenticatedUser } from "./routes";

export function parseOperatorAllowlist(configured: string | undefined): ReadonlySet<string> | null {
  if (configured === undefined || configured.trim() === "") return null;
  const values = configured.split(",").map((value) => value.trim());
  if (values.some((value) => value.length === 0) || new Set(values).size !== values.length) return null;
  return new Set(values);
}

export type OperatorReadDependencies = {
  opsOperatorUserIds?: string;
  currentUser(request: Request): Promise<AuthenticatedUser | null>;
};

/** Commissioner role and email never grant platform-operator visibility. */
export async function requireOperatorRead(c: Context, dependencies: OperatorReadDependencies): Promise<{ user?: AuthenticatedUser; response?: Response }> {
  const allowlist = parseOperatorAllowlist(dependencies.opsOperatorUserIds);
  if (!allowlist) return { response: c.json({ code: "OPS_CONFIGURATION_UNAVAILABLE" }, 503) };
  const user = await dependencies.currentUser(c.req.raw);
  if (!user) return { response: c.json({ code: "UNAUTHENTICATED" }, 401) };
  if (!allowlist.has(user.id)) return { response: c.json({ code: "FORBIDDEN" }, 403) };
  return { user };
}
