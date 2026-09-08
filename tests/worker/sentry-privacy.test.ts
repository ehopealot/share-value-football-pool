import { describe, expect, it } from "vitest";
import { sanitizeSentryEvent } from "../../src/observability/sentry-sanitize";

const secret = "provider-key-fixture";

describe("Sentry event privacy", () => {
  it("rebuilds nested errors with only safe frames, debug metadata, and category fingerprint", () => {
    const safeDebugId = "123e4567-e89b-42d3-a456-426614174000";
    const event = sanitizeSentryEvent({
      platform: "javascript",
      request: { url: `https://api.example/?apiKey=${secret}`, cookies: "session-token" },
      extra: { balance: "1000000" },
      tags: { sentry_runtime: "worker", sentry_category: "outbox-producer-delivery-failure" },
      exception: { values: [{ value: secret, stacktrace: { frames: [
        { filename: `https://officepool.football/reset?token=${secret}`, function: secret },
        { filename: "https://officepool.football/assets/app-safe.js", lineno: 12, colno: 4 }
      ] } }] },
      debug_meta: { images: [{ type: "sourcemap", code_file: "https://officepool.football/assets/app-safe.js", debug_id: safeDebugId }] }
    } as never);

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("1000000");
    expect(event?.fingerprint).toEqual(["sentry", "worker", "outbox-producer-delivery-failure"]);
    expect(serialized).toContain("/assets/app-safe.js");
    expect(serialized).toContain(safeDebugId);
  });

  it("uses different stable fingerprints for unrelated finite categories", () => {
    const base = { tags: { sentry_runtime: "worker", sentry_category: "backup-run-failure" } } as never;
    const same = { tags: { sentry_runtime: "worker", sentry_category: "backup-run-failure" } } as never;
    const other = { tags: { sentry_runtime: "worker", sentry_category: "projection-queue-consumer-retry" } } as never;
    expect(sanitizeSentryEvent(base)?.fingerprint).toEqual(sanitizeSentryEvent(same)?.fingerprint);
    expect(sanitizeSentryEvent(base)?.fingerprint).not.toEqual(sanitizeSentryEvent(other)?.fingerprint);
  });
});
