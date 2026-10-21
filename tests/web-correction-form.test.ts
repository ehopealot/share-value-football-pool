import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrozenAdminCommand } from "../src/web/admin-command";
import { api } from "../src/web/api";
import { regradeWagerRequest } from "../src/contracts/http";
import { WagerCorrectionForm } from "../src/web/components/WagerCorrectionForm";
import type { CorrectionWager } from "../src/web/correction-results";

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(), useEffect: () => {}, useRef: () => ({ current: null }),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  }
}));
let command: FrozenAdminCommand<Record<string, unknown>>;
vi.mock("../src/web/admin-command", async original => ({
  ...await original<typeof import("../src/web/admin-command")>(),
  useFrozenAdminCommand: () => ({ get pending() { return command.pending; }, run: command.run.bind(command), retire: command.retire.bind(command) })
}));
vi.mock("../src/web/api", () => ({ api: { command: vi.fn() }, errorMessage: (error: Error) => error.message }));

const wager: CorrectionWager = {
  wagerId: "w", seasonId: "s", memberId: "m", memberDisplayName: "Alice", type: "straight", status: "won", confirmedAt: "2020-01-01T00:00:00Z", weekStart: "2019-12-31T08:00:00Z", performanceMicros: "0",
  legs: [{ eventId: "event-1", league: "nfl", homeTeam: "Kansas City Chiefs", awayTeam: "Buffalo Bills", eventStartsAt: "2020-01-02T00:00:00Z", canonicalBook: "DraftKings", retrievedAt: "2020-01-01T00:00:00Z", policyVersion: "p", offerVersion: "o", market: "spread", selection: "home", originalOdds: -110, homeScore: 24, awayScore: 17 }]
};
const onCancel = vi.fn(); const onSuccess = vi.fn();
let action: "void" | "regrade";
function render() { hooks.cursor = 0; return WagerCorrectionForm({ slug: "pool", wager, action, onCancel, onSuccess }); }
function nodes(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function field(name: string) { return nodes(render()).find(node => node.props.name === name)!; }
function change(name: string, value: string) { field(name).props.onChange({ target: { value } }); }
function button(text: string) { return nodes(render()).find(node => node.type === "button" && node.props.children === text)!; }
async function submit() { await nodes(render()).find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); }

beforeEach(() => {
  hooks.cursor = 0; hooks.values = []; action = "regrade"; command = new FrozenAdminCommand();
  vi.clearAllMocks(); vi.mocked(api.command).mockResolvedValue({ commandVersion: "2" });
});

describe("wager correction form", () => {
  it("shows read-only event identity and team-labelled score inputs, never JSON or version entry", () => {
    const html = renderToStaticMarkup(render());
    expect(html).toContain("Kansas City Chiefs score"); expect(html).toContain("Buffalo Bills score");
    expect(field("eventId-0").props).toMatchObject({ value: "event-1", readOnly: true });
    expect(field("league-0").props).toMatchObject({ value: "NFL", readOnly: true });
    expect(field("homeScore-0").props.value).toBe("24");
    expect(html).not.toContain("textarea"); expect(html).not.toContain("correctionVersion");
    expect(button("Submit regrade").props.disabled).toBe(true);
  });

  it("requires a reason and valid scores before sending", async () => {
    await submit(); expect(api.command).not.toHaveBeenCalled();
    change("reason", "Official review"); change("homeScore-0", "");
    await submit(); expect(api.command).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(render())).toContain("Enter a nonnegative whole-number score for Kansas City Chiefs.");
  });

  it("submits typed evidence with a hidden generated version and announces success", async () => {
    change("reason", "Official review"); change("awayScore-0", "27"); await submit();
    expect(api.command).toHaveBeenCalledWith("pool", "/admin/corrections/w/regrade", {
      reason: "Official review", idempotencyKey: expect.any(String), correctedResults: [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 24, awayScore: 27, correctionVersion: expect.stringMatching(/^commissioner:/) }]
    });
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("reuses generated identity after failure and retires it only on a semantic edit", async () => {
    vi.mocked(api.command).mockRejectedValue(new Error("Network unavailable"));
    change("reason", "Official review"); await submit();
    expect(onSuccess).not.toHaveBeenCalled(); expect(field("reason").props.value).toBe("Official review");
    await submit();
    const first = vi.mocked(api.command).mock.calls[0][2];
    expect(vi.mocked(api.command).mock.calls[1][2]).toEqual(first);
    change("homeScore-0", "25"); await submit();
    expect(vi.mocked(api.command).mock.calls[2][2]).not.toEqual(first);
    const changed = regradeWagerRequest.parse(vi.mocked(api.command).mock.calls[2][2]);
    const original = regradeWagerRequest.parse(first);
    expect(changed.idempotencyKey).not.toEqual(original.idempotencyKey);
    expect(changed.correctedResults[0].correctionVersion).not.toEqual(original.correctedResults[0].correctionVersion);
  });

  it("disables edits/cancel while pending and ignores duplicate submit", async () => {
    let resolve!: (value: { commandVersion: string }) => void;
    vi.mocked(api.command).mockImplementation(() => new Promise(done => { resolve = done; }));
    change("reason", "Official review"); const pending = submit();
    expect(button("Cancel").props.disabled).toBe(true); expect(field("reason").props.disabled).toBe(true);
    await submit(); expect(api.command).toHaveBeenCalledOnce(); expect(onSuccess).not.toHaveBeenCalled();
    resolve({ commandVersion: "2" }); await pending; expect(onSuccess).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "no_contest"])("hides score inputs and submits null scores for %s", async status => {
    change("reason", "Official result"); change("status-0", status);
    expect(field("homeScore-0")).toBeUndefined(); await submit();
    expect(vi.mocked(api.command).mock.calls[0][2]).toMatchObject({ correctedResults: [{ status, homeScore: null, awayScore: null }] });
  });

  it("lets the commissioner cancel without issuing a command", () => {
    button("Cancel").props.onClick(); expect(onCancel).toHaveBeenCalledOnce(); expect(api.command).not.toHaveBeenCalled();
  });

  it("voids with just the required reason and no event evidence", async () => {
    action = "void"; expect(field("homeScore-0")).toBeUndefined(); change("reason", "Refund review"); await submit();
    expect(api.command).toHaveBeenCalledWith("pool", "/admin/corrections/w/void", { reason: "Refund review", idempotencyKey: expect.any(String) });
  });
});
