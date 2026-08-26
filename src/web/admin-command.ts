import { useCallback, useRef, useState } from "react";

const freeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Retains one immutable browser command identity until success or a semantic edit retires it. */
export class FrozenAdminCommand<T extends object> {
  private frozen?: { identity: string; body: Readonly<T> };
  private inFlight = false;

  get pending() { return this.inFlight; }

  retire() {
    if (!this.inFlight) this.frozen = undefined;
  }

  async run<R>(identity: string, createBody: () => T, send: (body: Readonly<T>) => Promise<R>): Promise<R | undefined> {
    if (this.inFlight) return undefined;
    if (!this.frozen || this.frozen.identity !== identity) this.frozen = { identity, body: freeze(structuredClone(createBody())) };
    const attempt = this.frozen;
    this.inFlight = true;
    try {
      const result = await send(attempt.body);
      if (this.frozen === attempt) this.frozen = undefined;
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}

export function useFrozenAdminCommand<T extends object>() {
  const command = useRef(new FrozenAdminCommand<T>()).current;
  const [, render] = useState(0);
  const retire = useCallback(() => { command.retire(); render((value) => value + 1); }, [command]);
  const run = useCallback(async <R,>(identity: string, createBody: () => T, send: (body: Readonly<T>) => Promise<R>) => {
    if (command.pending) return undefined;
    const promise = command.run(identity, createBody, send);
    render((value) => value + 1);
    try { return await promise; } finally { render((value) => value + 1); }
  }, [command]);
  return { pending: command.pending, retire, run };
}
