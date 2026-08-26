import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireTurnstileToken, TurnstileClientError } from "../src/web/api";

describe("explicit Turnstile lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("renders into the actual target and removes a completed widget before another acquisition", async () => {
    const callbacks: Array<{ callback: (token: string) => void }> = [];
    const render = vi.fn((container: HTMLElement, options: { callback: (token: string) => void }) => { callbacks.push(options); return `widget-${callbacks.length}`; });
    const execute = vi.fn(); const remove = vi.fn(); const replaceChildren = vi.fn();
    const target = { id: "turnstile-form", setAttribute: vi.fn(), replaceChildren } as unknown as HTMLElement;
    vi.stubGlobal("document", { querySelector: () => ({ content: "configured-site-key" }) });
    vi.stubGlobal("window", { turnstile: { ready: (callback: () => void) => callback(), render, execute, remove } });
    const first = acquireTurnstileToken(target);
    await Promise.resolve();
    expect(render).toHaveBeenCalledWith(target, expect.objectContaining({ sitekey: "configured-site-key", execution: "execute" }));
    expect(render).not.toHaveBeenCalledWith("turnstile-form", expect.anything());
    callbacks[0]!.callback("first-token");
    await expect(first).resolves.toBe("first-token");
    expect(remove).toHaveBeenCalledWith("widget-1");
    expect(replaceChildren).toHaveBeenCalledTimes(1);

    const second = acquireTurnstileToken(target);
    await Promise.resolve();
    callbacks[1]!.callback("second-token");
    await expect(second).resolves.toBe("second-token");
    expect(execute).toHaveBeenLastCalledWith("widget-2");
    expect(remove).toHaveBeenLastCalledWith("widget-2");
    expect(replaceChildren).toHaveBeenCalledTimes(2);
  });

  it("removes and clears the target after error and expiry before a later acquisition", async () => {
    for (const failure of ["error-callback", "expired-callback"] as const) {
      const callbacks: Array<Record<string, (token?: string) => void>> = [];
      const remove = vi.fn(); const replaceChildren = vi.fn();
      const target = { id: "turnstile-form", setAttribute: vi.fn(), replaceChildren } as unknown as HTMLElement;
      vi.stubGlobal("document", { querySelector: () => ({ content: "configured-site-key" }) });
      vi.stubGlobal("window", { turnstile: { ready: (callback: () => void) => callback(), render: (_container: HTMLElement, options: Record<string, (token?: string) => void>) => { callbacks.push(options); return `widget-${callbacks.length}`; }, execute: () => undefined, remove } });
      const token = acquireTurnstileToken(target);
      await Promise.resolve();
      callbacks[0]![failure]!();
      await expect(token).rejects.toBeInstanceOf(TurnstileClientError);
      expect(remove).toHaveBeenCalledWith("widget-1");
      expect(replaceChildren).toHaveBeenCalledTimes(1);
      const retry = acquireTurnstileToken(target);
      await Promise.resolve();
      callbacks[1]!.callback("retry-token");
      await expect(retry).resolves.toBe("retry-token");
      vi.unstubAllGlobals();
    }
  });
});
