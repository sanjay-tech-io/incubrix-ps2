/** Fixed-window counter per key. In memory: fine for one API process (the public demo); a second instance would need a shared store. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(limitPerWindow: number, windowMs = 60_000, now: () => number = Date.now) {
    this.limit = limitPerWindow;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Returns 0 when allowed, otherwise the seconds to wait. */
  hit(key: string): number {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 10_000) for (const [k, v] of this.windows) if (t - v.start >= this.windowMs) this.windows.delete(k);
      return 0;
    }
    w.count++;
    return w.count > this.limit ? Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000)) : 0;
  }
}
