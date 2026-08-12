/** Lightweight type-safe event bus (one-way facts between components). */
export interface EventBus<Events extends Record<string, unknown>> {
  emit<K extends keyof Events & string>(kind: K, payload: Events[K]): void;
  on<K extends keyof Events & string>(kind: K, handler: (payload: Events[K]) => void): () => void;
  listenerCount<K extends keyof Events & string>(kind: K): number;
}

export function createEventBus<Events extends Record<string, unknown>>(): EventBus<Events> {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  return {
    emit(kind, payload) {
      const set = listeners.get(kind as string);
      if (set == null) return;
      for (const handler of [...set]) {
        try {
          handler(payload as never);
        } catch (error) {
          // a failing subscriber must not break the emit
          console.error(`[event-bus] subscriber for ${String(kind)} failed`, error);
        }
      }
    },
    on(kind, handler) {
      let set = listeners.get(kind as string);
      if (set == null) {
        set = new Set();
        listeners.set(kind as string, set);
      }
      set.add(handler as (payload: never) => void);
      return () => {
        set!.delete(handler as (payload: never) => void);
      };
    },
    listenerCount(kind) {
      return listeners.get(kind as string)?.size ?? 0;
    },
  };
}
