export type OpsSignal = { tone: "good" | "attention" | "bad" | "neutral"; label: string };

/** Relative times are deliberately anchored to a labeled snapshot, not a live clock. */
export function formatOpsTime(value: string | null, reference: number) {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp) || !Number.isFinite(reference)) return null;
  const seconds = (timestamp - reference) / 1_000;
  const [divisor, unit] = Math.abs(seconds) >= 86_400 ? [86_400, "day"] as const
    : Math.abs(seconds) >= 3_600 ? [3_600, "hour"] as const
    : Math.abs(seconds) >= 60 ? [60, "minute"] as const : [1, "second"] as const;
  return {
    dateTime: new Date(timestamp).toISOString(),
    relative: new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round(seconds / divisor), unit),
    exact: new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(timestamp)
  };
}

export function jobSignal(status: string, freshness: "current" | "stale" | "unknown"): OpsSignal {
  if (freshness === "unknown" || !["success", "not_due", "failed"].includes(status)) return { tone: "neutral", label: "Unknown" };
  if (status === "failed") return { tone: "bad", label: "Failed" };
  if (freshness === "stale") return { tone: "attention", label: "Needs attention" };
  return { tone: "good", label: "Recent check OK" };
}

export function scheduleSignal(value: string | null, reference: number): OpsSignal {
  if (value === null) return { tone: "neutral", label: "None observed" };
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(reference)) return { tone: "neutral", label: "Unknown" };
  return timestamp <= reference ? { tone: "attention", label: "Time passed" } : { tone: "neutral", label: "Scheduled" };
}
