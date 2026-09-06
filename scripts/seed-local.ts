import { isDirectExecution } from "./direct-entry.mjs";

const isLoopbackHostname = (hostname: string) => hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);

export function localSeedUrl(value: string): URL {
  let base: URL;
  try { base = new URL(value); }
  catch (error) { throw new Error("local-worker-url must be a valid absolute URL", { cause: error }); }
  if (base.protocol !== "http:" || base.username || base.password || !isLoopbackHostname(base.hostname)) {
    throw new Error("local-worker-url must be a credential-free HTTP loopback URL");
  }
  return new URL("/__local-test/seed", base);
}

export async function seedLocal(value: string, request: typeof fetch = fetch) {
  const response = await request(localSeedUrl(value), { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Local fixture seed failed (${response.status}): ${await response.text()}`);
}

if (isDirectExecution(import.meta.url)) {
  const baseUrl = process.argv[2];
  if (!baseUrl) throw new Error("Usage: tsx scripts/seed-local.ts <local-worker-url>");
  await seedLocal(baseUrl);
}
