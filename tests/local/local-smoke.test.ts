import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createWorkerApp } from "../../src/worker/app";
import { installLocalTestControls } from "../../src/worker/test-controls";
import { LOCAL_FIXTURE_EVENTS } from "../../src/odds/fixtures/runtime";
import { startLocalResponseBarrierWorker } from "../../scripts/local-response-barrier";
import { localSmokeMigrationArgs, localSmokeWorkerArgs, startLocalSmokeWorker } from "../../scripts/local-smoke";

describe("deterministic local smoke support", () => {
  it("ships completed and placeable canonical Super Bowl fixtures without disturbing upcoming order", () => {
    expect(LOCAL_FIXTURE_EVENTS.find((event) => event.id === "local-nfl-completed")).toEqual({
      id: "local-nfl-completed", sport: "nfl", status: "final", commenceTime: "2024-02-11T23:30:00.000Z",
      postseason: true, eventName: "Local Super Bowl", homeTeam: "Local Chiefs", awayTeam: "Local 49ers", homeScore: 25, awayScore: 22,
      bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Local Chiefs", price: -110, point: -2.5 }, { name: "Local 49ers", price: -110, point: 2.5 }] }] }]
    });
    const upcomingIndex = LOCAL_FIXTURE_EVENTS.findIndex((event) => event.id === "local-nfl-upcoming");
    const superBowlIndex = LOCAL_FIXTURE_EVENTS.findIndex((event) => event.id === "local-nfl-super-bowl");
    expect(upcomingIndex).toBeGreaterThanOrEqual(0);
    expect(superBowlIndex).toBeGreaterThan(upcomingIndex);
    expect(LOCAL_FIXTURE_EVENTS[upcomingIndex]).toMatchObject({ status: "scheduled", startOffsetMs: 24 * 60 * 60 * 1000 + 5 * 60 * 1000 });
    expect(LOCAL_FIXTURE_EVENTS[superBowlIndex]).toEqual({
      id: "local-nfl-super-bowl", sport: "nfl", status: "scheduled", startOffsetMs: 24 * 60 * 60 * 1000 + 6 * 60 * 1000,
      postseason: true, eventName: "T11 Local Super Bowl LXI", homeTeam: "T11 Super Home", awayTeam: "T11 Super Away",
      bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "T11 Super Home", price: -110, point: -4 }, { name: "T11 Super Away", price: -110, point: 4 }] }] }]
    });
  });

  it("does not install test controls unless explicit local/test configuration enables them", async () => {
    const production = createWorkerApp({
      db: {} as D1Database,
      pools: {} as DurableObjectNamespace,
      currentUser: async () => null
    });
    expect((await production.fetch(new Request("https://pool.example.test/__local-test/seed", { method: "POST" }))).status).toBe(404);
    expect((await production.fetch(new Request("https://pool.example.test/__local-test/current-time", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug: "local-smoke", currentTime: "2030-01-01T00:00:00.000Z" }) }))).status).toBe(404);
    expect((await production.fetch(new Request("https://pool.example.test/__local-test/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "local-nfl-super-bowl", homeScore: 27, awayScore: 24 }) }))).status).toBe(404);
    expect((await production.fetch(new Request("https://pool.example.test/__local-test/alarm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug: "local-smoke", currentTime: "2030-01-01T00:00:00.000Z" }) }))).status).toBe(404);

    const local = new Hono();
    installLocalTestControls(local, { enabled: true, seed: async () => ({ seeded: true }), setCurrentTime: async () => ({ currentTime: null }), finalizeResult: async ({ eventId }) => ({ finalized: true, eventId }), triggerAlarm: async () => ({ settled: true }) });
    expect((await local.fetch(new Request("https://pool.example.test/__local-test/seed", { method: "POST" }))).status).toBe(200);
  });

  it("installs bounded local fixture transitions only behind explicit controls", async () => {
    const calls: Array<[string, unknown]> = [];
    const local = new Hono();
    installLocalTestControls(local, {
      enabled: true,
      seed: async () => ({ seeded: true }),
      setCurrentTime: async (input) => { calls.push(["time", input]); return { currentTime: input.currentTime }; },
      finalizeResult: async (input) => { calls.push(["result", input]); return { finalized: true, eventId: input.eventId }; },
      triggerAlarm: async (input) => { calls.push(["alarm", input]); return { settled: true }; }
    });
    const post = (path: string, body: unknown) => local.fetch(new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(await (await post("/__local-test/current-time", { poolSlug: "local-smoke", currentTime: "2030-01-01T00:00:00.000Z" })).json()).toEqual({ currentTime: "2030-01-01T00:00:00.000Z" });
    expect(await (await post("/__local-test/current-time", { poolSlug: "local-smoke", currentTime: null })).json()).toEqual({ currentTime: null });
    // A pool-scoped read clock is meaningless without its explicit pool, and an unparseable instant is rejected.
    expect((await post("/__local-test/current-time", { currentTime: "2030-01-01T00:00:00.000Z" })).status).toBe(400);
    expect((await post("/__local-test/current-time", { poolSlug: "local-smoke", currentTime: "not-a-time" })).status).toBe(400);
    expect(await (await post("/__local-test/result", { eventId: "local-nfl-upcoming", homeScore: 24, awayScore: 17 })).json()).toEqual({ finalized: true, eventId: "local-nfl-upcoming" });
    expect(await (await post("/__local-test/result", { eventId: "local-nfl-super-bowl", homeScore: 27, awayScore: 24 })).json()).toEqual({ finalized: true, eventId: "local-nfl-super-bowl" });
    expect((await post("/__local-test/result", { eventId: "not-a-fixture", homeScore: 1, awayScore: 0 })).status).toBe(400);
    expect(await (await post("/__local-test/alarm", { poolSlug: "local-smoke", currentTime: "2030-01-01T00:00:00.000Z" })).json()).toEqual({ settled: true });
    expect(calls).toEqual([
      ["time", { poolSlug: "local-smoke", currentTime: "2030-01-01T00:00:00.000Z" }],
      ["time", { poolSlug: "local-smoke", currentTime: null }],
      ["result", { eventId: "local-nfl-upcoming", homeScore: 24, awayScore: 17 }],
      ["result", { eventId: "local-nfl-super-bowl", homeScore: 27, awayScore: 24 }],
      ["alarm", { poolSlug: "local-smoke", currentTime: "2030-01-01T00:00:00.000Z" }]
    ]);
  });

  it("uses one isolated Wrangler persistence directory for migrations and the worker", () => {
    const persistence = "/tmp/sentinel-persistence";
    const migrationArgs = localSmokeMigrationArgs("/sentinel/wrangler", persistence);
    const workerArgs = localSmokeWorkerArgs("/sentinel/wrangler", 24_123, persistence);

    expect(migrationArgs).toEqual(["/sentinel/wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistence, "--config", "wrangler.local.jsonc"]);
    expect(workerArgs).toEqual(["/sentinel/wrangler", "dev", "--local", "--env-file", "/dev/null", "--port=24123", "--persist-to", persistence, "--config", "wrangler.local.jsonc", "--var", "BETTER_AUTH_SECRET:local-smoke-auth-secret-with-32-characters", "--var", "POOL_COMMAND_AUTHENTICATOR_KEY:local-smoke-command-authenticator", "--var", "POOL_PROJECTION_SERVICE_TOKEN:local-smoke-projection-token", "--var", "POOL_BACKUP_SERVICE_TOKEN:local-smoke-backup-token"]);
    expect(migrationArgs[migrationArgs.indexOf("--persist-to") + 1]).toBe(persistence);
    expect(workerArgs[workerArgs.indexOf("--persist-to") + 1]).toBe(persistence);
  });

  it("fails direct local harnesses closed on occupied or indeterminate ports before spawning", async () => {
    type StartHarness = <T>(baseURL: string, spawnWorker: () => T, request?: typeof fetch) => Promise<T>;
    const verifyPreflight = async (start: StartHarness, baseURL: string, label: string) => {
      const occupiedSpawn = vi.fn(() => "occupied-spawned");
      await expect(start(baseURL, occupiedSpawn, vi.fn<typeof fetch>().mockResolvedValue(new Response("occupied")))).rejects.toThrow(`${label} port is already serving`);
      expect(occupiedSpawn).not.toHaveBeenCalled();

      const indeterminateSpawn = vi.fn(() => "indeterminate-spawned");
      await expect(start(baseURL, indeterminateSpawn, vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timed out", "TimeoutError")))).rejects.toThrow(`${label} port availability could not be confirmed`);
      expect(indeterminateSpawn).not.toHaveBeenCalled();

      const availableSpawn = vi.fn(() => "owned-worker");
      const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      await expect(start(baseURL, availableSpawn, vi.fn<typeof fetch>().mockRejectedValue(refused))).resolves.toBe("owned-worker");
      expect(availableSpawn).toHaveBeenCalledOnce();
    };

    await verifyPreflight(startLocalSmokeWorker, "http://127.0.0.1:24000", "local smoke Worker");
    await verifyPreflight(startLocalResponseBarrierWorker, "http://127.0.0.1:35000", "local response barrier Worker");
  });

  it("wires the local fixture refresh directly into the Worker app's pre-read boundary", async () => {
    const source = await readFile(new URL("../../src/index.local.ts", import.meta.url), "utf8");
    const file = ts.createSourceFile("src/index.local.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const namedImports = (moduleName: string) => {
      const declaration = file.statements.find((statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === moduleName
      );
      const bindings = declaration?.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => element.name.text) : [];
    };
    expect(namedImports("./worker/app")).toContain("createWorkerApp");
    expect(namedImports("./worker/test-controls")).toContain("refreshLocalFixtures");
    const forbiddenRuntimeModules = new Set(["./odds/the-odds-api-provider", "./worker/cron"]);
    expect(file.statements.filter((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && forbiddenRuntimeModules.has(statement.moduleSpecifier.text)
    )).toEqual([]);

    const defaultExport = file.statements.find((statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals);
    expect(defaultExport, "default Worker export").toBeDefined();
    if (!defaultExport || !ts.isIdentifier(defaultExport.expression)) throw new Error("default export must reference the local Worker");
    const workerName = defaultExport.expression.text;
    const workerDeclaration = file.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === workerName);
    const worker = workerDeclaration?.initializer;
    if (!worker || !ts.isObjectLiteralExpression(worker)) throw new Error("default local Worker must be an object literal");
    const fetchMethod = worker.properties.find((property): property is ts.MethodDeclaration =>
      ts.isMethodDeclaration(property) && ts.isIdentifier(property.name) && property.name.text === "fetch"
    );
    expect(fetchMethod, "default local Worker fetch method").toBeDefined();

    const calls: ts.CallExpression[] = [];
    const visitFetch = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createWorkerApp") calls.push(node);
      ts.forEachChild(node, visitFetch);
    };
    if (fetchMethod?.body) visitFetch(fetchMethod.body);
    expect(calls, "active createWorkerApp calls in default local Worker fetch").toHaveLength(1);
    const forbiddenReferences: string[] = [];
    const visitWorker = (node: ts.Node) => {
      if (ts.isIdentifier(node) && (node.text === "TheOddsApiProvider" || node.text === "runOddsCron")) forbiddenReferences.push(node.text);
      ts.forEachChild(node, visitWorker);
    };
    visitWorker(worker);
    expect(forbiddenReferences, "remote odds symbols in the active local Worker").toEqual([]);
    const options = calls[0]?.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) throw new Error("createWorkerApp must receive an object literal");
    const beforeOddsRead = options.properties.find((property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "beforeOddsRead"
    );
    expect(beforeOddsRead, "active createWorkerApp beforeOddsRead property").toBeDefined();
    const callback = beforeOddsRead!.initializer;
    if (!ts.isArrowFunction(callback) || !ts.isCallExpression(callback.body)) throw new Error("beforeOddsRead must directly call the fixture refresh");
    expect(callback.parameters).toHaveLength(0);
    expect(ts.isIdentifier(callback.body.expression) && callback.body.expression.text === "refreshLocalFixtures").toBe(true);
    const database = callback.body.arguments[0];
    expect(database && ts.isPropertyAccessExpression(database) && ts.isIdentifier(database.expression) && database.expression.text === "env" && database.name.text === "DB").toBe(true);
  });
});
