import { RateLimiter } from "./rate-limit";

export type TurnstileResult = { success: boolean; action?: string; hostname?: string; "error-codes"?: string[] };
export type AuthAbuseGuardOptions = {
  secret?: string;
  /** Canonical production hostname; local callers derive the request hostname. */
  expectedHostname?: string;
  /** Deliberate local-development opt-in. Never enable this in a production Worker; false or omission fails closed. */
  allowInsecureLocalAuth?: boolean;
  limiter: RateLimiter;
  fetcher?: typeof fetch;
};

/** Shared literal-string predicate; URL-derived request hostnames match localhost/127.0.0.1, while bare ::1 remains accepted for compatibility. */
export const isLoopbackHostname = (hostname: string | undefined) => hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

/**
 * Verifies a browser Turnstile response. The explicit loopback-local option
 * bypasses Siteverify entirely for the local harness.
 */
export async function verifyTurnstile(input: { secret?: string; token?: string; action?: string; remoteIp?: string; hostname?: string; fetcher?: typeof fetch; allowInsecureLocalAuth?: boolean }): Promise<boolean> {
  if (input.allowInsecureLocalAuth === true && isLoopbackHostname(input.hostname)) return true;
  if (!input.secret || !input.token || !input.action || !input.hostname) return false;
  const body = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.remoteIp) body.set("remoteip", input.remoteIp);
  try {
    const response = await (input.fetcher ?? fetch)("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    if (!response.ok) return false;
    const result = await response.json() as TurnstileResult;
    return result.success === true && result.action === input.action && result.hostname === input.hostname;
  } catch {
    return false;
  }
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
    if (!(await verifyTurnstile({ secret: options.secret, token: body.turnstileToken, action: "submit", remoteIp: ip, hostname: options.expectedHostname ?? new URL(request.url).hostname, fetcher: options.fetcher, allowInsecureLocalAuth: options.allowInsecureLocalAuth }))) return Response.json({ code: "TURNSTILE_REJECTED" }, { status: 403 });
    return null;
  };
}
