import type { ReadActivity } from "../../contracts/http";
import { activityLegGradeClass, formatActivityLeg } from "../activity-presentation";

type Leg = NonNullable<ReadActivity["activity"]["wagers"][number]["legs"]>[number];

/** Shared selected-side emphasis and per-leg grade colors. */
export function WagerLine({ leg }: { leg: Leg }) {
  const line = formatActivityLeg(leg);
  return <span className={activityLegGradeClass(leg.grade)}>{line.segments.map((segment, index) => segment.selected ? <strong key={index}>{segment.text}</strong> : <span key={index}>{segment.text}</span>)}</span>;
}
