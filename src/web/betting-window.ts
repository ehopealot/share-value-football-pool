import { useEffect, useState } from "react";
import { bettingOpensAt, isBettingOpen, nextWeekStart, weekStartOf } from "../domain/betting-week";

/** Refresh at the actual PT boundary, and after background tabs resume. Server time remains authoritative. */
export function useBettingWindow(): { open: boolean; currentWeek: string } {
  const [now, setNow] = useState(() => new Date());
  const week = weekStartOf(now);
  const open = isBettingOpen(now);
  const nextChange = open ? nextWeekStart(week).getTime() : bettingOpensAt(now).getTime();
  useEffect(() => {
    const refresh = () => setNow(new Date());
    const timer = setTimeout(refresh, Math.max(1, nextChange - Date.now()));
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [nextChange, now]);
  return { open, currentWeek: week.toISOString() };
}
