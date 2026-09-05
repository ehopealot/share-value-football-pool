import { durableProjectionSnapshotReader, ProjectionConsumer } from "../services/projections";

/** Retries only failed messages; duplicates and stale versions are acknowledged after durable recording. */
export async function consumeProjectionQueue(batch: MessageBatch<unknown>, dependencies: { db: D1Database; pools: DurableObjectNamespace; projectionServiceToken?: string }): Promise<void> {
  const consumer = new ProjectionConsumer(dependencies.db, durableProjectionSnapshotReader(dependencies.pools, dependencies.projectionServiceToken));
  for (const queued of batch.messages) {
    try {
      await consumer.consume(queued.body);
      queued.ack();
    } catch {
      queued.retry({ delaySeconds: 30 });
    }
  }
}
