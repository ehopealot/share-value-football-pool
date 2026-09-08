import * as Sentry from "@sentry/cloudflare";
import type { CloudflareOptions } from "@sentry/cloudflare";
import { sanitizeSentryEvent } from "./sentry-sanitize";

export type SentryEnv = { SENTRY_DSN?: string; CF_VERSION_METADATA?: { id?: string }; SENTRY_TEST_TRANSPORT?: CloudflareOptions["transport"]; SENTRY_TEST_FLUSHES?: Promise<unknown>[] };

/** Official Sentry createTransport with Workers native fetch; no tracing integrations or propagated headers. */
const cloudflareErrorTransport: NonNullable<CloudflareOptions["transport"]> = (options) => Sentry.createTransport(options, async (request) => {
  const response = await fetch(options.url, { method: "POST", headers: options.headers, body: request.body, signal: AbortSignal.timeout(1_000) });
  try { await response.body?.cancel(); } catch { /* response disposal is best effort */ }
  return { statusCode: response.status, headers: { "x-sentry-rate-limits": response.headers.get("X-Sentry-Rate-Limits"), "retry-after": response.headers.get("Retry-After") } };
});

/** Accept only a standard public-key Sentry DSN; malformed values disable reporting. */
export function hasSentryDsn(env: SentryEnv): env is SentryEnv & { SENTRY_DSN: string } {
  const value = env.SENTRY_DSN?.trim();
  if (!value) return false;
  try {
    const dsn = new URL(value);
    return (dsn.protocol === "https:" || dsn.protocol === "http:")
      && dsn.username.length > 0
      && dsn.hostname.length > 0
      && /\/(?:[^/]+\/)*\d+$/.test(dsn.pathname);
  } catch {
    return false;
  }
}

export const sentryOptionsFor = (env: SentryEnv): CloudflareOptions | undefined => {
  if (!hasSentryDsn(env)) return undefined;
  return {
    dsn: env.SENTRY_DSN.trim(),
    ...(env.SENTRY_TEST_TRANSPORT ? { transport: env.SENTRY_TEST_TRANSPORT } : {}),
    environment: "production",
    initialScope: { tags: { sentry_runtime: "worker", sentry_category: "unhandled" } },
    ...(env.CF_VERSION_METADATA?.id ? { release: env.CF_VERSION_METADATA.id } : {}),
    defaultIntegrations: false,
    skipOpenTelemetrySetup: true,
    tracePropagationTargets: [],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false }
    },
    beforeBreadcrumb: () => null,
    beforeSend: sanitizeSentryEvent
  };
};

export type SafeFaultCategory =
  | "hono-unhandled-route-failure"
  | "router-registry-lookup-failure"
  | "router-wager-revalidation-failure"
  | "router-do-dispatch-failure"
  | "router-do-decode-failure"
  | "registry-initialize-transport-failure"
  | "registry-initialize-decode-failure"
  | "registry-initialize-protocol-failure"
  | "registry-initialize-finalization-failure"
  | "pool-command-unexpected"
  | "pool-post-commit-alarm-schedule-failure"
  | "settlement-provider-source-failure"
  | "settlement-internal-state-or-invariant-failure"
  | "outbox-producer-delivery-failure"
  | "projection-queue-consumer-retry"
  | "backup-export-non-ok"
  | "backup-item-exception"
  | "backup-run-failure"
  | "scheduled-odds-poll-failure"
  | "browser-root-failure"
  | "durable-alarm-escaping-failure";

export function reportSafeFault(category: SafeFaultCategory, runtime: "worker" | "durable-object" | "browser" = "worker", stage?: string): void {
  try {
    Sentry.withScope((scope) => {
      scope.setTag("sentry_runtime", runtime);
      scope.setTag("sentry_category", category);
      if (stage) scope.setTag("sentry_stage", stage);
      scope.setFingerprint(["sentry", runtime, category, ...(stage ? [stage] : [])]);
      const client = Sentry.getIsolationScope().getClient() ?? Sentry.getCurrentScope().getClient();
      if (client) client.captureException(new Error("Sentry safe fault"), { captureContext: scope });
    });
  } catch {
    // Observability is strictly fail-open.
  }
}

/** Builds one explicit error-only client for a Worker or Durable Object invocation. */
export function createSentryReporter(env: SentryEnv, waitUntil?: (promise: Promise<unknown>) => void): (category: SafeFaultCategory, runtime?: "worker" | "durable-object" | "browser", stage?: string) => void {
  if (!hasSentryDsn(env)) return () => undefined;
  try {
    const client = new Sentry.CloudflareClient({ ...sentryOptionsFor(env)!, transport: env.SENTRY_TEST_TRANSPORT ?? cloudflareErrorTransport, integrations: [], stackParser: () => [] });
    client.init();
    return (category, runtime = "worker", stage) => {
      try {
        const scope = new Sentry.Scope();
        scope.setTag("sentry_runtime", runtime);
        scope.setTag("sentry_category", category);
        if (stage) scope.setTag("sentry_stage", stage);
        scope.setFingerprint(["sentry", runtime, category, ...(stage ? [stage] : [])]);
        client.captureException(new Error("Sentry safe fault"), { captureContext: scope });
        const flush = client.flush(1_000).catch(() => undefined);
        env.SENTRY_TEST_FLUSHES?.push(flush);
        if (waitUntil) waitUntil(flush);
        else void flush;
      } catch {
        // Capturing and flushing are post-business and fail-open.
      }
    };
  } catch {
    return () => undefined;
  }
}

/** Captures a post-business error through the explicit error-only invocation client. */
export function reportSafeFaultForEnv(env: SentryEnv, category: SafeFaultCategory, runtime: "worker" | "durable-object" | "browser" = "worker", stage?: string, waitUntil?: (promise: Promise<unknown>) => void): void {
  createSentryReporter(env, waitUntil)(category, runtime, stage);
}

/** Chooses exactly one raw or SDK-wrapped handler invocation for each event. */
export function withOptionalSentry<Env extends SentryEnv, Message = unknown, Metadata = unknown>(raw: ExportedHandler<Env, Message, Metadata>): ExportedHandler<Env, Message, Metadata> {
  const instrument = (handler: ExportedHandler<Env, Message, Metadata>) => Sentry.withSentry<Env, Message, Metadata>((env) => sentryOptionsFor(env), handler);
  return {
    fetch: raw.fetch && (async (request, env, ctx) => {
      if (!hasSentryDsn(env)) return raw.fetch!(request, env, ctx);
      let started = false; let completed: Response | undefined; let businessError: unknown;
      const wrapped = instrument({ ...raw, fetch: async (innerRequest) => {
        started = true;
        try { completed = await raw.fetch!(innerRequest, env, ctx); return completed; }
        catch (error) { businessError = error; throw error; }
      } });
      try { return await wrapped.fetch!(request, env, ctx); }
      catch (error) {
        if (!started) return raw.fetch!(request, env, ctx);
        if (businessError !== undefined) throw businessError;
        if (completed) return completed;
        throw error;
      }
    }),
    scheduled: raw.scheduled && (async (event, env, ctx) => {
      if (!hasSentryDsn(env)) return raw.scheduled!(event, env, ctx);
      let started = false; let businessError: unknown;
      const wrapped = instrument({ ...raw, scheduled: async (innerEvent) => {
        started = true;
        try { await raw.scheduled!(innerEvent, env, ctx); }
        catch (error) { businessError = error; throw error; }
      } });
      try { await wrapped.scheduled!(event, env, ctx); }
      catch (error) {
        if (!started) return raw.scheduled!(event, env, ctx);
        if (businessError !== undefined) throw businessError;
        throw error;
      }
    }),
    queue: raw.queue && (async (batch, env, ctx) => {
      if (!hasSentryDsn(env)) return raw.queue!(batch, env, ctx);
      let started = false; let businessError: unknown;
      const wrapped = instrument({ ...raw, queue: async (innerBatch) => {
        started = true;
        try { await raw.queue!(innerBatch, env, ctx); }
        catch (error) { businessError = error; throw error; }
      } });
      try { await wrapped.queue!(batch, env, ctx); }
      catch (error) {
        if (!started) return raw.queue!(batch, env, ctx);
        if (businessError !== undefined) throw businessError;
        throw error;
      }
    })
  };
}
