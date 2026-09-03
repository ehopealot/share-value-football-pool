# Odds Polling and Staleness Offset Design

## Goal

Decouple provider polling cadence from the member-facing stale threshold. The scheduled Worker already runs every two minutes; this change only determines when an invocation makes an Odds API request and when otherwise valid upcoming offers are withheld as stale.

## Poll cadence

Discovery, empty leagues, and scheduled games more than 24 hours away are due every 20 minutes. Scheduled games at or within 24 hours of kickoff are due every 5 minutes, including the final hour. In-progress games remain due every 2 minutes. A terminal event receives one post-final reconciliation follow-up at 5 minutes plus the existing 24-hour correction check. The persisted provider-quota backoff remains authoritative and may delay any of these target intervals.

## Staleness

Upcoming offers use one fixed 30-minute freshness threshold, independent of game proximity and polling cadence. An offer becomes stale only after it is older than that threshold. The 10-minute-or-more gap between the longest normal 20-minute polling target and the 30-minute stale threshold avoids transient stale banners when normal cron timing varies. Existing provider-error, malformed-offer, no-offer, offer-provenance, authorization, and wager-placement rules are unchanged.

## Implementation and tests

`pollInterval`, discovery cadence, and terminal reconciliation delay will be updated in the ingestion scheduler. `offerIsStale` will take only the retrieved timestamp and current time, making the fixed threshold explicit; routes and quote validation will use that decoupled helper. Tests will cover every schedule threshold, the 30-minute stale boundary for both close and distant games, discovery cadence, terminal follow-up, and quota backoff preservation.
