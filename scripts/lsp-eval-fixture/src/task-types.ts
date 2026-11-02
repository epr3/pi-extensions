/** A unit of work the queue can hold. */
export interface ReadTask {
  readonly id: string;
  run(): Promise<void>;
}

export abstract class BaseTask implements ReadTask {
  abstract readonly id: string;
  abstract run(): Promise<void>;

  /** Concrete subclasses describe what makes their work done. */
  abstract describe(): string;
}

export interface Priority {
  readonly weight: number;
}
