import { makeEvent } from "@kmc/zoom-automation";
import type { DomainEvent, EventType } from "@kmc/shared-types";

export type EventListener = (ev: DomainEvent) => void;

/** Single fan-out point for all domain events. */
export class EventBus {
  private listeners = new Set<EventListener>();

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(type: EventType, data: Record<string, unknown> = {}): DomainEvent {
    const ev = makeEvent(type, data);
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        // a bad listener must never break the bus
      }
    }
    return ev;
  }
}
