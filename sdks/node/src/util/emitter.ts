/** Minimal typed event emitter. Listener errors are isolated so one bad handler cannot break the SDK. */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as (payload: never) => void);
    return () => set!.delete(listener as (payload: never) => void);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K], onListenerError?: (err: unknown) => void): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        (listener as (p: Events[K]) => void)(payload);
      } catch (err) {
        onListenerError?.(err);
      }
    }
  }
}
