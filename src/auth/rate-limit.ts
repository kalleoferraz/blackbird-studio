/** In-memory failure counter per key, for the login route. It resets when the server restarts. */
export class FailureLimiter {
  private readonly entries = new Map<string, { count: number; since: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  /** Seconds to wait before the next try, or 0 when the key is not blocked. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (now - entry.since >= this.windowMs) {
      this.entries.delete(key);
      return 0;
    }
    return entry.count >= this.maxFailures ? Math.ceil((entry.since + this.windowMs - now) / 1000) : 0;
  }

  fail(key: string, now = Date.now()): void {
    if (this.entries.size > 5000) this.prune(now);
    const entry = this.entries.get(key);
    if (!entry || now - entry.since >= this.windowMs) this.entries.set(key, { count: 1, since: now });
    else entry.count += 1;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (now - entry.since >= this.windowMs) this.entries.delete(key);
  }
}
