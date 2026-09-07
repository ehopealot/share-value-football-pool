import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadPoolView } from "../src/contracts/http";
import type { FrozenAdminCommand } from "../src/web/admin-command";
import { api } from "../src/web/api";
import { AdminMembersPage, AdminMembersPageBody } from "../src/web/pages/AdminMembersPage";

// Exercise actual event handlers with the same lightweight hook harness used by Activity tests.
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], command: undefined as FrozenAdminCommand<Record<string, unknown>> | undefined }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  }
}));
vi.mock("react-router", () => ({ useParams: () => ({ slug: "pool" }), Link: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/web/components/Layout", () => ({ Layout: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/web/admin-command", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/web/admin-command")>();
  return { ...original, useFrozenAdminCommand: () => {
    const command = hooks.command ??= new original.FrozenAdminCommand<Record<string, unknown>>();
    return { pending: command.pending, retire: () => command.retire(), run: command.run.bind(command) };
  } };
});

const css = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");
const fixture: ReadPoolView = {
  commandVersion: "1", pool: { poolId: "pool", slug: "pool", name: "Pool", commissionerId: "owner", signupsOpen: true, maxSideBetMicros: "800000000", commissionerNotice: null, commissionerRules: null },
  currentMember: { memberId: "owner", role: "commissioner", seasonBalances: [], hasUnreadBoard: false },
  members: [
    { memberId: "owner", displayName: "Owner", email: "owner@example.test", role: "commissioner", status: "active" },
    { memberId: "alice", displayName: "Alice", email: "alice@example.test", role: "member", status: "active" }
  ], activeSeason: null, nextDraftSeason: null, latestClosedSeason: null, commissioner: { seasonOrders: [] }
};
type Props = { children?: ReactNode; onClick?: () => void; disabled?: boolean };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function renderPage() { hooks.cursor = 0; return AdminMembersPageBody({ slug: "pool" }); }
function button(page: ReactNode, label: string) {
  const control = elements(page).find((node) => node.type === "button" && node.props.children === label);
  expect(control, label).toBeDefined();
  return control!;
}
function click(page: ReactNode, label: string) { button(page, label).props.onClick!(); }

beforeEach(() => {
  vi.restoreAllMocks();
  hooks.values = [structuredClone(fixture)];
  hooks.command = undefined;
  vi.spyOn(api, "poolView").mockResolvedValue(structuredClone(fixture));
  vi.spyOn(api, "command").mockResolvedValue({});
});

describe("member administration", () => {
  it("keys the page by pool so a confirmation cannot carry over to a different pool", () => {
    expect(AdminMembersPage().key).toBe("pool");
  });

  it("shows email in its own column with headers only on the commissioner screen", () => {
    const table = renderToStaticMarkup(renderPage());
    expect(table).toContain('<th scope="row">Alice</th><td class="admin-member-email">alice@example.test</td>');
    for (const label of ["Name", "Email", "Role", "Status"]) expect(table).toContain(`<th scope="col">${label}</th>`);
    expect(table).toContain('<th scope="colgroup" colSpan="2">Actions</th>');
    expect(css).toContain('.admin-member-email { white-space: nowrap; }');
    expect(css).not.toContain('.admin-member-email { overflow-wrap: anywhere; }');
    hooks.values[0] = { ...fixture, currentMember: { ...fixture.currentMember, role: "member" } };
    const html = renderToStaticMarkup(renderPage());
    expect(html).toContain("Only the commissioner");
    expect(html).not.toContain("alice@example.test");
  });

  it.each([
    ["Make commissioner", "Confirm transfer", "/admin/transfer", "You will lose commissioner access"],
    ["Suspend", "Confirm suspension", "/admin/members/alice/suspend", "prevents them from accessing this pool"]
  ])("requires review and supports cancel before %s", async (action, confirm, path, warning) => {
    click(renderPage(), action);
    const review = renderPage();
    expect(renderToStaticMarkup(review)).toContain("Alice");
    expect(renderToStaticMarkup(review)).toContain(warning);
    button(review, confirm);
    expect(api.command).not.toHaveBeenCalled();
    click(review, "Cancel");
    expect(api.command).not.toHaveBeenCalled();
    click(renderPage(), action);
    click(renderPage(), confirm);
    await vi.waitFor(() => expect(api.poolView).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(hooks.values[1]).toEqual({ tag: "idle" }));
    expect(api.command).toHaveBeenCalledTimes(1);
    expect(api.command).toHaveBeenCalledWith("pool", path, expect.objectContaining({ idempotencyKey: expect.any(String) }));
    if (action === "Make commissioner") expect(vi.mocked(api.command).mock.calls[0][2]).toMatchObject({ memberId: "alice" });
  });

  it.each([["Make commissioner", "Confirm transfer"], ["Suspend", "Confirm suspension"]])("keeps %s errors on review and reuses the command key on retry", async (action, confirm) => {
    vi.mocked(api.command).mockRejectedValueOnce(new Error("Temporary failure"));
    click(renderPage(), action);
    click(renderPage(), confirm);
    await vi.waitFor(() => expect(renderToStaticMarkup(renderPage())).toContain("Service unavailable."));
    click(renderPage(), confirm);
    await vi.waitFor(() => expect(api.poolView).toHaveBeenCalledTimes(1));
    const calls = vi.mocked(api.command).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][2]).toEqual(calls[1][2]);
  });

  it("disables confirmation and cancel while pending, then reloads the former commissioner's access", async () => {
    let resolveCommand!: (value: unknown) => void;
    vi.mocked(api.command).mockImplementationOnce(() => new Promise(resolve => { resolveCommand = resolve; }));
    vi.mocked(api.poolView).mockResolvedValueOnce({ ...fixture, currentMember: { ...fixture.currentMember, role: "member" } });
    click(renderPage(), "Make commissioner");
    click(renderPage(), "Confirm transfer");
    const pending = renderPage();
    expect(button(pending, "Confirming…").props.disabled).toBe(true);
    expect(button(pending, "Cancel").props.disabled).toBe(true);
    click(pending, "Confirming…");
    click(pending, "Cancel");
    expect(api.command).toHaveBeenCalledTimes(1);
    resolveCommand({});
    await vi.waitFor(() => expect(renderToStaticMarkup(renderPage())).toContain("Only the commissioner"));
  });

  it("uses compact actions with wrapping that overrides scroll-container nowrap and mobile-only table sizing", () => {
    expect(css).toContain('.admin-members-table .admin-member-action { max-width: 7.5rem; min-height: 2.25rem; padding: 0.35rem 0.5rem; white-space: normal; line-height: 1.2; }');
    expect(css).toContain('@media (max-width: 600px) { .admin-members-table { font-size: 0.875rem; } .admin-members-table th, .admin-members-table td { padding: 0.35rem; } .admin-members-table .admin-member-action { min-height: 44px; } }');
  });
});
