import { formatAmericanOdds } from "../odds-format";
import type { ReadActivity } from "../../contracts/http";
import { activityLegGradeClass, formatActivityLeg } from "../activity-presentation";

type Leg = NonNullable<ReadActivity["activity"]["wagers"][number]["legs"]>[number];

/** Shared selected-side emphasis and per-leg grade colors. */
export function WagerLine({ leg, wagerType }: { leg: Leg; wagerType: "straight" | "parlay" | "teaser" }) {
  const line = formatActivityLeg(leg);
  const odds = wagerType === "straight" ? 100 : wagerType === "parlay" ? leg.placementOdds : undefined;
  return <span className={activityLegGradeClass(leg.grade)}>{line.segments.map((segment, index) => segment.selected ? <strong key={index}>{segment.text}</strong> : <span key={index}>{segment.text}</span>)}{odds !== undefined && <> ({formatAmericanOdds(odds)})</>}</span>;
}
