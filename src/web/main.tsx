import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import "./styles.css";
import { App } from "./app";
import { initializeBrowserSentry } from "./sentry";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const sentryEnabled = initializeBrowserSentry();
const reactRoot = sentryEnabled
  ? createRoot(root, { onUncaughtError: Sentry.reactErrorHandler(), onRecoverableError: Sentry.reactErrorHandler() })
  : createRoot(root);
reactRoot.render(sentryEnabled
  ? <Sentry.ErrorBoundary fallback={<p role="alert">Something went wrong. Refresh and try again.</p>}><App /></Sentry.ErrorBoundary>
  : <App />);
