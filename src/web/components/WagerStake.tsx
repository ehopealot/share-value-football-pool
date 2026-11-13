import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ReadActivity } from "../../contracts/http";
import { formatActivityStake } from "../activity-presentation";
import { formatSignedLine } from "../odds-format";
import { sortWagerLegsByStartTime } from "../wager-presentation";
import { WagerLine } from "./WagerLine";

type Wager = ReadActivity["activity"]["wagers"][number];
type Leg = NonNullable<Wager["legs"]>[number];

function teaserLineChange(leg: Leg): string {
  const original = leg.originalLine?.trim();
  const adjusted = leg.adjustedLine?.trim();
  if (!original || !adjusted || !Number.isFinite(Number(original)) || !Number.isFinite(Number(adjusted))) return "Line adjustment unavailable.";
  const format = leg.market === "spread" ? formatSignedLine : String;
  return `${leg.market === "spread" ? "Spread" : "Total"}: ${format(Number(original))} → ${format(Number(adjusted))} (${formatSignedLine(Number(adjusted) - Number(original))} points)`;
}

/** Uses only already-authorized read data; never fetches or reconstructs hidden selections. */
export function MultiWagerLegs({ wager }: { wager: Wager }) {
  const legs = sortWagerLegsByStartTime(wager.legs ?? []);
  const hidden = wager.hiddenLegCount ?? 0;
  return <>
    {legs.length > 0 && <ul className="wager-stake-legs">{legs.map((leg, index) => <li key={`${leg.eventId}:${leg.market}:${leg.selection}:${index}`}>
      <WagerLine leg={leg} wagerType={wager.type} showOdds/>
      {wager.type === "teaser" && <p>{teaserLineChange(leg)}</p>}
    </li>)}</ul>}
    {hidden > 0 ? <p>{hidden} selection{hidden === 1 ? "" : "s"} hidden until game time.</p> : legs.length === 0 ? <p>Selections hidden until game time.</p> : null}
  </>;
}

function StakeDialog({ wager, opener, onClose }: { wager: Wager; opener: HTMLButtonElement | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const stake = formatActivityStake(wager);
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);
  // Dismiss through React state, not the queued native close event from effect cleanup (StrictMode reopens).
  return createPortal(<dialog ref={dialogRef} className="wager-stake-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <header className="wager-stake-dialog-header"><h2 id={titleId}>{wager.type === "teaser" ? "Teaser" : "Parlay"} details</h2><button type="button" autoFocus onClick={onClose}>Close</button></header>
    {stake && <p className="wager-stake-summary">{stake.amount} shares{stake.odds && <> · Ticket odds {stake.odds}</>}</p>}
    <MultiWagerLegs wager={wager}/>
  </dialog>, document.body);
}

export function WagerStake({ wager, fallback = null }: { wager: Wager; fallback?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const stake = formatActivityStake(wager);
  if (!stake) return <>{fallback}</>;
  const terms = <>{stake.amount}{stake.odds && <> <small className="activity-staked-odds">{stake.odds}</small></>}</>;
  if (wager.type === "straight") return <span className="activity-staked">{terms}</span>;
  return <>
    <button type="button" ref={triggerRef} className="activity-staked wager-stake-button" aria-haspopup="dialog" aria-label={`View ${wager.type} legs: ${stake.amount} shares${stake.odds ? ` at ${stake.odds}` : ""}`} onClick={() => setOpen(true)}>{terms}</button>
    {open && <StakeDialog wager={wager} opener={triggerRef.current} onClose={() => setOpen(false)}/>}
  </>;
}
