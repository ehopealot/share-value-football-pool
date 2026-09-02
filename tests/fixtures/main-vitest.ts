/**
 * Vitest-only PoolDO Worker: tests use bindings/modules directly, so it omits fetch
 * dependencies, queue consumers, and crons. Its far-future grace covers only
 * post-command scheduling; driven due non-terminal alarms need future fixtures or deleteAlarm().
 */
export { PoolDO } from "../../src/durable/pool-do";

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler;
