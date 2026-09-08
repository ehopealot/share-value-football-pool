import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { sanitizeSentryEvent } from "../../src/observability/sentry-sanitize";
import { initializeBrowserSentry } from "../../src/web/sentry";

const secret = "browser-secret-fixture";

describe("optional browser Sentry setup", () => {
  it("does not initialize without a public DSN", () => {
    expect(initializeBrowserSentry()).toBe(false);
  });

  it("captures a throwing child once with a safe absolute asset stack", async () => {
    const envelopes: unknown[] = [];
    expect(initializeBrowserSentry({ dsn: "https://public@sentry.invalid/1", transport: () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true }) })).toBe(true);
    Sentry.setTag("sentry_category", "browser-root-failure");
    const target = document.createElement("div");
    const root = createRoot(target);
    const Throw = () => { throw new Error(secret); };
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await act(async () => {
        root.render(<Sentry.ErrorBoundary fallback={<p role="alert">fallback</p>}><Throw /></Sentry.ErrorBoundary>);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(target.textContent).toBe("fallback");
      expect(envelopes).toHaveLength(1);
      const serialized = JSON.stringify(envelopes);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain("browser-root-failure");
    } finally {
      root.unmount();
      console.error = originalError;
      await Sentry.close(0);
    }
  });
});
