import { EventEmitter } from "node:events";
import type { SyncEvent } from "@applaud/shared";

class SyncEventBus extends EventEmitter {
  emitEvent(event: SyncEvent): void {
    this.emit("event", event);
  }
  onEvent(fn: (e: SyncEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

export const syncEvents = new SyncEventBus();
syncEvents.setMaxListeners(100);

export function emit(type: SyncEvent["type"], extra: Partial<SyncEvent> = {}): void {
  syncEvents.emitEvent({ type, at: Date.now(), ...extra });
}
