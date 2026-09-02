/**
 * Vitest-only Worker entry. Every worker test talks to the PoolDO binding or
 * imports application modules directly; none fetch SELF. Re-exporting only the
 * Durable Object keeps better-auth/drizzle/hono out of each test isolate's
 * main-worker import, which the vitest-pool-workers runner re-evaluates for
 * every test file. The vitest wrangler config declares no queue consumers or
 * cron triggers, so nothing ever dispatches into the stub default entrypoint.
 */
export { PoolDO } from "../../src/durable/pool-do";

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler;
