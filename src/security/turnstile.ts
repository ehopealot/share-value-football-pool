import { RateLimiter } from "./rate-limit";

export type TurnstileResult = { success: boolean; "error-codes"?: string[] };
export type AuthAbuseGuardOptions = {
  secret?: string;
  /** Deliberate local-development opt-in. Never set this in a production Worker. */
  allowInsecureLocalAuth?: boolean;
  limiter: RateLimiter;
  fetcher?: typeof fetch;
};

/**
 * Verifies a browser Turnstile response. A missing secret is rejected unless the
 * caller explicitly enables the documented local-only escape hatch.
 */
const isLoopbackHostname = (hostname: string | undefined) => hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

export async function verifyTurnstile(input: { secret?: string; token?: string; remoteIp?: string; hostname?: string; fetcher?: typeof fetch; allowInsecureLocalAuth?: boolean }): Promise<boolean> {
  // The missing-token bypass exists solely for the explicitly loopback-bound local harness.
  if (input.allowInsecureLocalAuth === true && isLoopbackHostname(input.hostname)) return true;
  if (!input.secret || !input.token) return false;
  const body = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.remoteIp) body.set("remoteip", input.remoteIp);
  const response = await (input.fetcher ?? fetch)("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  if (!response.ok) return false;
  return (await response.json() as TurnstileResult).success === true;
}

/** The shared signup/signin abuse boundary used by the Worker auth route. */
export function createAuthAbuseGuard(options: AuthAbuseGuardOptions): (request: Request) => Promise<Response | null> {
  return async (request) => {
    if (!/\/(sign-up|sign-in)\/email$/.test(new URL(request.url).pathname) || request.method !== "POST") return null;
    const origin = request.headers.get("origin");
    if (!origin || new URL(origin).origin !== new URL(request.url).origin) return Response.json({ code: "CSRF_REJECTED" }, { status: 403 });
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!options.limiter.allow(`auth:${ip}`)) return Response.json({ code: "RATE_LIMITED" }, { status: 429 });
    const body = await request.clone().json().catch(() => ({})) as { turnstileToken?: string };
    if (!(await verifyTurnstile({ secret: options.secret, token: body.turnstileToken, remoteIp: ip, hostname: new URL(request.url).hostname, fetcher: options.fetcher, allowInsecureLocalAuth: options.allowInsecureLocalAuth }))) return Response.json({ code: "TURNSTILE_REJECTED" }, { status: 403 });
    return null;
  };
}
