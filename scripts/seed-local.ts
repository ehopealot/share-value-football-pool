const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("Usage: tsx scripts/seed-local.ts <local-worker-url>");
const response = await fetch(new URL("/__local-test/seed", baseUrl), { method: "POST", signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Local fixture seed failed (${response.status}): ${await response.text()}`);
