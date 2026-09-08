import * as Sentry from "@sentry/react";
import { sanitizeSentryEvent } from "../observability/sentry-sanitize";

const configuredDsn = () => {
  const value = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!value) return undefined;
  try {
    const dsn = new URL(value);
    return (dsn.protocol === "https:" || dsn.protocol === "http:") && dsn.username && dsn.hostname && /\/(?:[^/]+\/)*\d+$/.test(dsn.pathname) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** Browser setup is optional: a missing or malformed public DSN leaves React untouched. */
export function initializeBrowserSentry(testOptions?: { dsn?: string; transport?: Parameters<typeof Sentry.init>[0]["transport"] }) {
  const dsn = testOptions?.dsn ?? configuredDsn();
  if (!dsn) return false;
  try {
    Sentry.init({
      dsn,
      ...(testOptions?.transport ? { transport: testOptions.transport } : {}),
      environment: "production",
      defaultIntegrations: false,
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
      beforeSend: (event) => sanitizeSentryEvent(event as never)
    });
    Sentry.setTags({ sentry_runtime: "browser", sentry_category: "unhandled" });
    return true;
  } catch {
    return false;
  }
}
