import type { ReactNode } from "react";
import { Link } from "react-router";
import { weekStartOf } from "../../domain/betting-week";
import { matchupDetailsAvailable } from "../pages/OddsPage";

type LinkableLeg = { eventId: string; eventStartsAt: string };

/** Current-week legs open their matchup page (details pregame, box score once started); other weeks stay plain text. */
export function MatchupLegLink({ slug, leg, children }: { slug: string; leg: LinkableLeg; children: ReactNode }) {
  if (!matchupDetailsAvailable(leg.eventStartsAt, weekStartOf(new Date()).toISOString())) return <>{children}</>;
  return <Link className="matchup-link" to={`/p/${encodeURIComponent(slug)}/matchups/${encodeURIComponent(leg.eventId)}`}>{children}</Link>;
}

export const matchupHintText = "Tap any matchup to see details.";
/** Smaller than the pickers it sits under; only current-week views link matchups. */
export function MatchupHint() {
  return <p className="matchup-hint">{matchupHintText}</p>;
}
