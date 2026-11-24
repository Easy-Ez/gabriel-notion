import { cancelledError } from "../errors.js";

/** Resolves after `ms`, rejecting with CANCELLED as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Collapses concurrent calls with the same key into one in-flight promise. */
export class Singleflight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  do(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

/** Full-jitter exponential backoff: random(0, min(cap, base * 2^attempt)). */
export function fullJitterDelay(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

/** Combines optional signals into one. */
export function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  if (real.length === 1) return real[0]!;
  return AbortSignal.any(real);
}

/** Limits how many async tasks run at once. */
export class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}
