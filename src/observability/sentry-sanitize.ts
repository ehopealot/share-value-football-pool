import type { ErrorEvent } from "@sentry/cloudflare";

const categories = new Set([
  "unhandled",
  "hono-unhandled-route-failure",
  "router-registry-lookup-failure",
  "router-wager-revalidation-failure",
  "router-do-dispatch-failure",
  "router-do-decode-failure",
  "registry-initialize-transport-failure",
  "registry-initialize-decode-failure",
  "registry-initialize-protocol-failure",
  "registry-initialize-finalization-failure",
  "pool-command-unexpected",
  "pool-post-commit-alarm-schedule-failure",
  "durable-alarm-escaping-failure",
  "settlement-provider-source-failure",
  "settlement-internal-state-or-invariant-failure",
  "outbox-producer-delivery-failure",
  "projection-queue-consumer-retry",
  "backup-export-non-ok",
  "backup-item-exception",
  "backup-run-failure",
  "scheduled-odds-poll-failure",
  "browser-root-failure"
]);
const runtimes = new Set(["worker", "durable-object", "browser", "unknown"]);
const stages = new Set([
  "super-bowl-source-read",
  "super-bowl-reconciliation-write",
  "result-source-read",
  "result-snapshot-parse",
  "result-settle-wagers",
  "result-lifecycle-write"
]);
const debugId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeRelease = /^[A-Za-z0-9._-]{1,128}$/;

const safeBundlePath = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  let path = value;
  if (value.startsWith("https://") || value.startsWith("http://")) {
    try {
      const url = new URL(value);
      if (url.search || url.hash || url.username || url.password || !/^[A-Za-z0-9.-]+$/.test(url.hostname)) return undefined;
      path = url.pathname;
    } catch { return undefined; }
  }
  if (path.includes(":") || path.includes("?") || path.includes("#") || path.includes("..") || path.includes("\\")) return undefined;
  if (/^\/assets\/[A-Za-z0-9._-]+\.(?:js|mjs)$/.test(path) || /^(?:worker|index|assets\/[A-Za-z0-9._-]+)\.(?:js|mjs)$/.test(path)) return path;
  return undefined;
};

const finite = (value: unknown, allowed: Set<string>, fallback: string) => typeof value === "string" && allowed.has(value) ? value : fallback;

/** Rebuilds a Sentry event from a small allowlist; it never forwards source event objects. */
export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent | null {
  const tags = event.tags ?? {};
  const runtime = finite(tags.sentry_runtime, runtimes, "unknown");
  const category = finite(tags.sentry_category, categories, "unhandled");
  const stage = finite(tags.sentry_stage, stages, "");
  const values = event.exception?.values?.slice(0, 4).map((value) => {
    const frames = value.stacktrace?.frames?.flatMap((frame) => {
      const filename = safeBundlePath(frame.filename);
      if (!filename) return [];
      return [{ filename, lineno: typeof frame.lineno === "number" ? frame.lineno : undefined, colno: typeof frame.colno === "number" ? frame.colno : undefined, in_app: true }];
    }).slice(0, 64);
    return { type: "SentrySafeFault", value: "Unexpected runtime failure", ...(frames?.length ? { stacktrace: { frames } } : {}) };
  });
  const images = ((event as unknown as { debug_meta?: { images?: unknown[] } }).debug_meta?.images ?? []).flatMap((image) => {
    if (!image || typeof image !== "object") return [];
    const input = image as { type?: unknown; code_file?: unknown; debug_id?: unknown };
    const codeFile = safeBundlePath(input.code_file);
    return input.type === "sourcemap" && codeFile && typeof input.debug_id === "string" && debugId.test(input.debug_id)
      ? [{ type: "sourcemap", code_file: codeFile, debug_id: input.debug_id }]
      : [];
  });
  const fingerprint = ["sentry", runtime, category, ...(stage ? [stage] : [])];
  return {
    platform: event.platform,
    level: "error",
    ...(typeof event.environment === "string" && safeRelease.test(event.environment) ? { environment: event.environment } : {}),
    ...(typeof event.release === "string" && safeRelease.test(event.release) ? { release: event.release } : {}),
    fingerprint,
    tags: { sentry_runtime: runtime, sentry_category: category, ...(stage ? { sentry_stage: stage } : {}) },
    ...(values?.length ? { exception: { values } } : {}),
    ...(images.length ? { debug_meta: { images } } : {})
  } as unknown as ErrorEvent;
}
