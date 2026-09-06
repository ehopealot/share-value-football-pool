/** Per-isolate rolling-window HTTP abuse guard. */
export class RateLimiter {
  private readonly attempts = new Map<string, number[]>();
  constructor(private readonly limit = 5, private readonly windowMs = 10 * 60 * 1000) {}

  allow(key: string, now = Date.now()): boolean {
    const recent = (this.attempts.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (recent.length >= this.limit) { this.attempts.set(key, recent); return false; }
    recent.push(now); this.attempts.set(key, recent); return true;
  }

  reset(key: string): void { this.attempts.delete(key); }

  /** Local fixtures may clear their own explicitly installed limiter without changing production behavior. */
  clear(): void { this.attempts.clear(); }
}
