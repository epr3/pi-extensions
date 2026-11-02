import { BatchSink, formatLine, makeFanout } from "./sinks.ts";
import { BaseTask, ReadTask } from "./task-types.ts";

class SyncTask extends BaseTask {
  constructor(readonly id: string) {
    super();
  }
  async run(): Promise<void> {}
  describe(): string {
    return `sync task ${this.id}`;
  }
}

export class TaskQueue {
  private items: ReadTask[] = [];
  private sink = new BatchSink();

  constructor(private readonly name: string) {}

  add(task: ReadTask): void {
    this.items.push(task);
    this.sink.emit("info", `queued ${task.id}`);
  }

  get size(): number {
    return this.items.length;
  }

  flush(): string[] {
    const lines = this.sink.drain();
    return lines.map((l) => formatLine("audit", l));
  }
}
