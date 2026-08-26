import { OddsIngestion, type IngestionProvider } from "../odds/ingestion";
import type { Clock } from "../platform/clock";

/** Cron only refreshes D1 sports data. It does not dispatch or authorize pool settlement. */
export async function runOddsCron(db: D1Database, provider: IngestionProvider, clock?: Clock) {
  return new OddsIngestion(db, provider, clock).poll();
}
