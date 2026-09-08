import { durableProjectionSnapshotReader, ProjectionConsumer } from "../services/projections";
import { reportSafeFault } from "../observability/sentry-server";

/** Retries only failed messages; duplicates and stale versions are acknowledged after durable recording. */
export async function consumeProjectionQueue(batch: MessageBatch<unknown>, dependencies: { db: D1Database; pools: DurableObjectNamespace; projectionServiceToken?: string; report?: (category: "projection-queue-consumer-retry") => void }): Promise<void> {
  const consumer = new ProjectionConsumer(dependencies.db, durableProjectionSnapshotReader(dependencies.pools, dependencies.projectionServiceToken));
  for (const queued of batch.messages) {
    try {
      await consumer.consume(queued.body);
      queued.ack();
    } catch {
      (dependencies.report ?? (() => reportSafeFault("projection-queue-consumer-retry"))) ("projection-queue-consumer-retry");
      queued.retry({ delaySeconds: 30 });
    }
  }
}
