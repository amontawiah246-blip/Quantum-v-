// Small concurrency helpers used by the market agents and the verification coordinator.
// Nothing here knows about trading: it only keeps one slow request from holding up the rest.

/** Runs at most `max` tasks at once; the rest wait their turn (first come, first served). */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try { return await fn(); }
    finally { this.active--; this.waiters.shift()?.(); }
  }
}

export type LimiterOutcome<T> = { ran: true; value: T } | { ran: false; reason: string };

/**
 * Runs at most `max` tasks at once and always starts the FRESHEST waiting task first (highest priority number).
 * Just before a task would start, `canRun` may veto it (for example: the candidate is already too old to trade), so no slow
 * request is spent on evidence that can no longer be used.
 */
export class PriorityLimiter {
  private active = 0;
  private queue: { priority: number; seq: number; start: () => void }[] = [];
  private seq = 0;
  constructor(private max: number) {}

  run<T>(priority: number, fn: () => Promise<T>, canRun?: () => string | null): Promise<LimiterOutcome<T>> {
    return new Promise((resolve, reject) => {
      const start = () => {
        const veto = canRun?.() ?? null;
        if (veto) { resolve({ ran: false, reason: veto }); return false; }
        this.active++;
        fn().then((value) => resolve({ ran: true, value }), reject).finally(() => { this.active--; this.pump(); });
        return true;
      };
      this.queue.push({ priority, seq: this.seq++, start });
      this.pump();
    });
  }

  private pump() {
    while (this.active < this.max && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i], b = this.queue[best];
        if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
      }
      this.queue.splice(best, 1)[0].start();
    }
  }
  get waiting() { return this.queue.length; }
}

/** Rejects with `label timed out` after `ms`; the timer never keeps the process alive. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); (timer as any)?.unref?.(); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
