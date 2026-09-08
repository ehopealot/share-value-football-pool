import type { ReadActivity } from "../../contracts/http";
import { formatActivityStake } from "../activity-presentation";
import { displayWagerStartTimes, sortWagerLegsByStartTime } from "../wager-presentation";
import { WagerLine } from "./WagerLine";

type Wager = ReadActivity["activity"]["wagers"][number];

/** Uses only authorized read-model terms, never reconstructing hidden selections. */
export function CorrectionWagerSummary({ wager, showOwner = false }: { wager: Wager; showOwner?: boolean }) {
  const legs = sortWagerLegsByStartTime(wager.legs ?? []);
  const starts = displayWagerStartTimes(wager);
  const stake = formatActivityStake(wager);
  return <div className="correction-wager-summary">
    {showOwner && <strong>{wager.memberDisplayName}</strong>}
    <small className="correction-wager-meta">{wager.type}{stake && <> · <span className="activity-staked">{stake.amount} shares{stake.odds && <> <span className="activity-staked-odds">{stake.odds}</span></>}</span></>}</small>
    {legs.length ? legs.map((leg, index) => <div className="correction-wager-leg" key={`${leg.eventId}:${leg.market}:${leg.selection}:${index}`}>
      <small><time dateTime={leg.eventStartsAt}>{starts[index]}</time></small>
      <WagerLine leg={leg}/>
    </div>) : <span>Selection hidden until game time.</span>}
    {!!wager.hiddenLegCount && legs.length > 0 && <small>{wager.hiddenLegCount} other selection{wager.hiddenLegCount === 1 ? "" : "s"} hidden until game time.</small>}
  </div>;
}
