import { useEffect, useState } from "react";

/** Mobile tables regroup wagers by kickoff-day anchor; desktop keeps earliest-kickoff order. Non-browser renders default to desktop. */
export function useCompactWagerViewport(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 600px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}
