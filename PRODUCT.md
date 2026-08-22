# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the operator: TypeScript end to end, deployed on Cloudflare. Use established libraries and Cloudflare services for authentication, signup, abuse prevention, persistence, and other standard web-app concerns. The selected implementation stack is React and Vite for the browser, Hono on Cloudflare Workers, D1 for global data, and a SQLite-backed Durable Object as the authoritative state machine for each pool.

## Users

The primary users are friends, coworkers, and other small private groups who want to compete throughout the NFL and college-football season by paper-trading sportsbook wagers. A user can hold one global account, belong to multiple pools, and create a pool as its commissioner.

A pool has exactly one commissioner. The commissioner remains a normal betting member while also controlling membership settings, season opening, share issuance, corrections, and pool administration.

## Product Purpose

Share Pool is a private football competition in which members wager virtual shares on real NFL and college-football lines. It recreates the appeal of OfficeFootballPool's former True Share format while adding straight moneylines and fixed-rule teasers.

The product succeeds when a private group can create and join a reusable pool, run a complete season without spreadsheet bookkeeping, understand the changing value of its shares, place and settle wagers fairly, and review an auditable history afterward.

## Positioning

Unlike a pick'em pool, each member manages a virtual share position against a paper sportsbook. Winning wagers create shares, losing wagers destroy shares, and the common share price rises or falls with the pool's outstanding float. Commissioner-issued share orders execute at the current price without moving that price.

## Operating Context

Members check a shared odds board throughout football season, place whole-share straight wagers or teasers before kickoff, and follow standings and revealed selections as games begin. NFL and NCAA football coexist in one season and may be mixed in a teaser. The season can run from a commissioner-selected opening through the Super Bowl.

Pool membership is private. A pool URL admits existing members directly and gives nonmembers a password join flow only while the commissioner has signups open. Members join with zero shares and cannot wager until the commissioner issues shares.

## Capabilities and Constraints

- The product is exclusively virtual paper trading. It never takes payments, holds money, enables withdrawals, or represents virtual dollar values as redeemable funds.
- Accounts exist independently of pools. Any account may create a pool for free in the first release. A future release may require a paid entitlement to activate a season; billing is not part of this release.
- Pools persist across separately archived seasons. Membership persists, but each season has independent share orders, balances, wagers, float, price, and results. At most one season is active.
- The commissioner opens a season. It closes after the Super Bowl is final and all wagers settle, or earlier if every outstanding share is lost.
- Members begin with zero shares. Only the commissioner issues shares, using a virtual-dollar or share-quantity order at the current share price. A season may define a default initial-order amount for commissioner convenience, but joining never issues it automatically.
- Straight wager markets are sides, totals, and moneylines. Sides and totals pay even money; moneylines use the accepted American price.
- Teasers support 6, 6.5, 7, 7.5, and 10 points under one fixed, versioned system-wide ruleset. Teasers may mix NFL/NCAA sides and totals; moneylines are ineligible.
- Wager stakes are whole shares with a minimum of one. Fractional winnings and order remainders remain in balances and float but are not independently wagerable.
- Accepted lines and prices are immutable snapshots. Confirmed wagers cannot be canceled by a member. Administrative voids and regrades are reversing audit events, never edits or deletions.
- Unstarted selections are hidden from every human, including the commissioner. A teaser reveals each leg only when that leg starts.
- Pool data, standings, orders, and revealed selections are visible only to authenticated pool members.
- One system-wide canonical odds-source policy applies to every pool. The first provider is a documented odds API behind an adapter; undocumented public endpoints are not a launch dependency.

## Brand Commitments

The interface intentionally recalls a useful 2007-era football-pool website: direct, compact, table-oriented, and visibly made from simple CSS. It must not drift into a contemporary rounded-card dashboard. Rounded corners, drop shadows, glass effects, decorative gradients, and ornamental motion are excluded.

The historical OfficeFootballPool site is a behavioral and era reference, not a source of copied trademarks, logos, or claims of affiliation.

## Evidence on Hand

- The operator supplied a full historical wager ledger demonstrating straight, moneyline, parlay, teaser, push, and adjusted-teaser outcomes.
- Archived OfficeFootballPool Share Pool pages recovered through the Internet Archive describe Simple and True Share modes, configurable starting shares, sides/totals, pick hiding, and its compact table-based interaction model.
- The original service did not provide a verified canonical table for every requested teaser size. This product therefore publishes a transparent, versioned house table rather than claiming an industry-universal payout table.
- No product name, logo, customer claims, testimonials, or production odds-provider contract has been supplied. Future work must not fabricate them.

## Product Principles

1. **Accounting must explain itself.** Every share and price change traces to an immutable order or wager event.
2. **No privileged picks.** Administrative power never reveals a member's unstarted selection.
3. **Accepted terms stay accepted.** A locked line, moneyline, or teaser ruleset never changes after confirmation.
4. **Private-group simplicity.** Joining, funding, betting, and following standings should remain understandable without sportsbook expertise.
5. **Period character, current reliability.** The interface may look like 2007, but security, accessibility, responsiveness, testing, and operational behavior must be contemporary.

## Accessibility & Inclusion

The web interface must meet WCAG 2.2 AA for keyboard access, focus visibility, semantic tables and forms, contrast, error identification, and non-color status cues. Dense desktop tables must remain usable on small screens without hiding required information.
