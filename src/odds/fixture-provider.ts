import type { League, OddsProvider, ProviderEvent, ProviderPoll } from "./types";

/** Deterministic provider used by local development and tests; it performs no network I/O. */
export class FixtureOddsProvider implements OddsProvider {
  constructor(private readonly fixtures: readonly ProviderEvent[]) {}
  async events(league: League): Promise<ProviderPoll> {
    return { events: this.fixtures.filter((event) => event.sport === league).map((event) => structuredClone(event)) };
  }
}
