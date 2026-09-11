import { canonicalTeamIdentity } from "./market-semantics";
import type { ProviderEvent } from "./types";

type Teams = Pick<ProviderEvent, "homeTeam" | "awayTeam">;

/** Provider home/away designations can flip at neutral sites; team identity cannot. */
export function eventTeamOrder(expected: Teams, actual: Teams): "same" | "swapped" | "conflict" {
  const home = canonicalTeamIdentity(expected.homeTeam); const away = canonicalTeamIdentity(expected.awayTeam);
  const incomingHome = canonicalTeamIdentity(actual.homeTeam); const incomingAway = canonicalTeamIdentity(actual.awayTeam);
  if (home === away || incomingHome === incomingAway) return "conflict";
  if (home === incomingHome && away === incomingAway) return "same";
  return home === incomingAway && away === incomingHome ? "swapped" : "conflict";
}

/** Keep stored wager sides stable. Bookmaker outcomes are team-named, so never invert their lines. */
export function orientProviderEvent(expected: Teams, event: ProviderEvent): ProviderEvent | undefined {
  const order = eventTeamOrder(expected, event);
  if (order === "conflict") return undefined;
  if (order === "same") return { ...event, ...expected };
  const teamNames = [event.homeTeam, event.awayTeam].map(canonicalTeamIdentity);
  const bookmakers = event.bookmakers.map((book) => ({ ...book, markets: book.markets.map((market) => ({ ...market, outcomes: market.outcomes.map((outcome) => {
    const name = canonicalTeamIdentity(outcome.name);
    if (market.key === "total" || teamNames.includes(name)) return outcome;
    // The normalized provider contract also permits side aliases. Bind them to
    // the incoming team before changing orientation; odds and line signs stay put.
    return { ...outcome, name: name === "home" ? event.homeTeam : name === "away" ? event.awayTeam : outcome.name };
  }) })) }));
  return { ...event, ...expected, homeScore: event.awayScore, awayScore: event.homeScore, bookmakers };
}
