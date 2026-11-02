/** Shape every concrete sink obeys. See `sinks.ts` for implementations. */
export interface Emitter {
  emit(level: string, message: string): void;
}

export class ConsoleEmitter implements Emitter {
  emit(level: string, message: string): void {
    console.log(`[${level}] ${message}`);
  }
}

/** Null sink: drops everything; used by tests and dry runs. */
export class SilentEmitter implements Emitter {
  emit(_level: string, _message: string): void {
    /* intentionally empty */
  }
}

/** Fans one event out to several sinks. */
export class FanoutEmitter implements Emitter {
  constructor(private readonly sinks: Emitter[]) {}
  emit(level: string, message: string): void {
    for (const s of this.sinks) s.emit(level, message);
  }
}
