import type { ProviderEvent } from "../types";

type LocalFixtureBase = Omit<ProviderEvent, "commenceTime" | "status">;
export type LocalFixtureEvent =
  | (LocalFixtureBase & { status: "final"; commenceTime: string })
  | (LocalFixtureBase & { status: "scheduled"; startOffsetMs: number });

/** Fixed local data: one completed provider result plus two renewable future offers. */
export const LOCAL_FIXTURE_EVENTS: readonly LocalFixtureEvent[] = [
  {
    id: "local-nfl-completed",
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
    sport: "nfl",
    status: "scheduled",
    startOffsetMs: 24 * 60 * 60 * 1000 + 5 * 60 * 1000,
    homeTeam: "Local Home",
    awayTeam: "Local Away",
    bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Local Home", price: -110, point: -3 }, { name: "Local Away", price: -110, point: 3 }] }, { key: "total", outcomes: [{ name: "Over", price: -110, point: 45.5 }, { name: "Under", price: -110, point: 45.5 }] }] }]
  },
  {
    id: "local-nfl-super-bowl",
    sport: "nfl",
    status: "scheduled",
    // Starts after the established upcoming fixture so its seeded offer order remains stable.
    startOffsetMs: 24 * 60 * 60 * 1000 + 6 * 60 * 1000,
    homeTeam: "T11 Super Home",
    awayTeam: "T11 Super Away",
    postseason: true,
    eventName: "T11 Local Super Bowl LXI",
    bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "T11 Super Home", price: -110, point: -4 }, { name: "T11 Super Away", price: -110, point: 4 }] }] }]
  }
];
