import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type OpsSummary, type PoolInspection } from "../src/web/api";
import { OpsPage } from "../src/web/pages/OpsPage";

const hooks = vi.hoisted(() => ({ cursor: 0, refCursor: 0, values: [] as unknown[], refs: [] as Array<{ current: number }> }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: () => {},
  useRef: (initial: number) => hooks.refs[hooks.refCursor++] ??= { current: initial },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? (value as (prior: unknown) => unknown)(hooks.values[index]) : value; }];
  }
}));
vi.mock("../src/web/components/Layout", () => ({ Layout: ({ children }: { children: ReactNode }) => children }));

const pageSource = readFileSync(resolve(import.meta.dirname, "../src/web/pages/OpsPage.tsx"), "utf8");
const router = readFileSync(resolve(import.meta.dirname, "../src/web/router.tsx"), "utf8");
const summary: OpsSummary = { readiness: { operatorAllowlist: true, poolInspection: true, oddsJob: true, backupJob: false }, jobs: [], limitations: { perPoolBackgroundMonitoring: false, automatedNotifications: false, inAppRepair: false } };
const inspection = (alarmAt: string): PoolInspection => ({ initialized: true, status: "observed", sampledAt: "2026-09-10T00:00:00.000Z", reconciliationRetryAt: null, discoveryRetryAt: null, outboxRetryAt: null, alarmAt, pendingReconciliationCount: 0, pendingOutboxCount: 0, exhaustedOutboxCount: 0, exhaustedOutboxCategories: [] });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
type Props = { children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void; disabled?: boolean };
const elements = (node: ReactNode): ReactElement<Props>[] => Array.isArray(node) ? node.flatMap(elements) : isValidElement<Props>(node) ? [node, ...elements(node.props.children)] : [];
const render = () => { hooks.cursor = 0; hooks.refCursor = 0; return OpsPage(); };

beforeEach(() => {
  vi.restoreAllMocks();
  hooks.values = [summary, "pool-a", undefined, "", false];
  hooks.refs = [];
  vi.spyOn(api, "opsSummary").mockResolvedValue(summary);
});

describe("reduced read-only operations page", () => {
  it("exposes status and on-demand inspection without repair or notification controls", () => {
    expect(router).toContain('path="/ops"');
    expect(pageSource).toContain("Latest job evidence");
    expect(pageSource).toContain("Inspect current scheduling");
    expect(pageSource).toContain("reports observations only");
    expect(pageSource).not.toMatch(/repairScheduling|repair-scheduling|>Repair scheduling<|sendOperational|retryDelivery/);
  });

  it("clears a labeled result when the editable pool target changes", async () => {
    vi.spyOn(api, "inspectPool").mockResolvedValue(inspection("2026-09-10T00:01:00.000Z"));
    let page = render();
    elements(page).find((element) => element.type === "button")!.props.onClick!();
    await Promise.resolve(); await Promise.resolve();
    page = render();
    expect(renderToStaticMarkup(page)).toContain("Inspection target: pool-a");
    elements(page).find((element) => element.type === "input")!.props.onChange!({ target: { value: "pool-b" } });
    const changed = renderToStaticMarkup(render());
    expect(changed).not.toContain("Inspection target: pool-a");
    expect(changed).not.toContain("2026-09-10T00:01:00.000Z");
  });

  it("labels results with the captured pool and ignores an older overlapping response", async () => {
    const poolA = deferred<PoolInspection>();
    const poolB = deferred<PoolInspection>();
    vi.spyOn(api, "inspectPool").mockImplementation((poolId) => poolId === "pool-a" ? poolA.promise : poolB.promise);

    let page = render();
    elements(page).find((element) => element.type === "button")!.props.onClick!();
    page = render();
    elements(page).find((element) => element.type === "input")!.props.onChange!({ target: { value: "pool-b" } });
    page = render();
    elements(page).find((element) => element.type === "button")!.props.onClick!();

    poolB.resolve(inspection("2026-09-10T00:02:00.000Z"));
    await Promise.resolve(); await Promise.resolve();
    poolA.resolve(inspection("2026-09-10T00:01:00.000Z"));
    await Promise.resolve(); await Promise.resolve();

    const html = renderToStaticMarkup(render());
    expect(html).toContain("Inspection target: pool-b");
    expect(html).toContain("2026-09-10T00:02:00.000Z");
    expect(html).not.toContain("2026-09-10T00:01:00.000Z");
  });
});
