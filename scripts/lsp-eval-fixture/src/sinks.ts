import { Emitter, FanoutEmitter } from "./emitters.ts";

export class FileSink implements Emitter {
  private lines: string[] = [];
  emit(level: string, message: string): void {
    this.lines.push(`${level}: ${message}`);
  }
  /** How many events this sink has swallowed so far. */
  get count(): number {
    return this.lines.length;
  }
}

export class BatchSink implements Emitter {
  private buf: string[] = [];
  emit(level: string, message: string): void {
    this.buf.push(formatLine(level, message));
  }
  drain(): string[] {
    const out = this.buf;
    this.buf = [];
    return out;
  }
}

export function formatLine(level: string, message: string): string {
  return `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
}

export function makeFanout(...sinks: Emitter[]): FanoutEmitter {
  return new FanoutEmitter(sinks);
}

// TODO(eventions): max buffer size for BatchSink.
