import { displayTeamName } from "../team-display";

type SelectedLegDisplayProps = {
  league: "nfl" | "ncaaf";
  awayTeam?: string;
  homeTeam?: string;
  market: "spread" | "total" | "moneyline";
  selection: "away" | "home" | "over" | "under";
  selectedDetail?: string;
};

/** Keeps the selection in its matchup context instead of repeating it in a separate pick field. */
export function SelectedLegDisplay({ league, awayTeam, homeTeam, market, selection, selectedDetail }: SelectedLegDisplayProps) {
  const away = displayTeamName(league, awayTeam ?? "Away");
  const home = displayTeamName(league, homeTeam ?? "Home");
  if (market === "total") return <><span>{away} at {home} </span><strong>{selection === "over" ? "O" : "U"}{selectedDetail ?? ""}</strong></>;
  const detail = selectedDetail ? ` (${selectedDetail})` : "";
  return selection === "away"
    ? <><strong>{away}{detail}</strong><span> at {home}</span></>
    : <><span>{away} at </span><strong>{home}{detail}</strong></>;
}
