import { formatLog } from "./tags.ts";

/** Every sender funnels through this emitter. */
export function emit(level: string, message: string): void {
  console.log(formatLog(level, message));
}

// TODO(eventions): route through the queue in batch.ts once it lands.
