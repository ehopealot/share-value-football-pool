import type { ProviderEvent } from "../types";

/** Fixed local data: one completed provider result plus one future offer for repeatable HTTP journeys. */
export type LocalFixtureEvent = ProviderEvent & { completed: boolean };

export const LOCAL_FIXTURE_EVENTS: readonly LocalFixtureEvent[] = [
  {
    id: "local-nfl-completed",
    completed: true,
    sport: "nfl",
    commenceTime: "2024-02-11T23:30:00.000Z",
    homeTeam: "Local Chiefs",
    awayTeam: "Local 49ers",
    status: "final",
    homeScore: 25,
    awayScore: 22,
    postseason: true,
    eventName: "Local Super Bowl",
    bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Local Chiefs", price: -110, point: -2.5 }, { name: "Local 49ers", price: -110, point: 2.5 }] }] }]
  },
  {
    id: "local-nfl-upcoming",
    completed: false,
    sport: "nfl",
    // A fresh, near-future offer keeps local quotes placeable without a frozen calendar.
    commenceTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    homeTeam: "Local Home",
    awayTeam: "Local Away",
    status: "scheduled",
    bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Local Home", price: -110, point: -3 }, { name: "Local Away", price: -110, point: 3 }] }, { key: "total", outcomes: [{ name: "Over", price: -110, point: 45.5 }, { name: "Under", price: -110, point: 45.5 }] }] }]
  },
  {
    id: "local-nfl-super-bowl",
    completed: false,
    sport: "nfl",
    // Starts after the established upcoming fixture so its offer order remains stable.
    commenceTime: new Date(Date.now() + 6 * 60 * 1000).toISOString(),
    homeTeam: "T11 Super Home",
    awayTeam: "T11 Super Away",
    status: "scheduled",
    postseason: true,
    eventName: "T11 Local Super Bowl LXI",
    bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "T11 Super Home", price: -110, point: -4 }, { name: "T11 Super Away", price: -110, point: 4 }] }] }]
  }
];

/** Removes local-only metadata before passing fixtures through the production provider contract. */
export const localProviderEvents = (): ProviderEvent[] => LOCAL_FIXTURE_EVENTS.map(({ completed: _completed, ...event }) => structuredClone(event));
