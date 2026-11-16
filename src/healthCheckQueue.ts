type Pending = {
  id: string;
  signal: AbortSignal;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  cancel: () => void;
};

/** Shared across dialogs so closing and reopening cannot exceed the limit. */
export class HealthCheckQueue {
  private pending: Pending[] = [];
  private active = new Set<string>();
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid health check concurrency limit");
    this.limit = limit;
  }

  schedule(id: string, signal: AbortSignal, run: () => Promise<void>): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const task: Pending = {
        id, signal, run, resolve, reject,
        cancel: () => {
          const index = this.pending.indexOf(task);
          if (index < 0) return;
          this.pending.splice(index, 1);
          signal.removeEventListener("abort", task.cancel);
          resolve();
          this.drain();
        },
      };
      signal.addEventListener("abort", task.cancel, { once: true });
      this.pending.push(task);
      this.drain();
    });
  }

  private drain() {
    while (this.active.size < this.limit) {
      const index = this.pending.findIndex((task) => !this.active.has(task.id));
      if (index < 0) break;
      const task = this.pending.splice(index, 1)[0];
      task.signal.removeEventListener("abort", task.cancel);
      this.active.add(task.id);
      Promise.resolve().then(() => { if (!task.signal.aborted) return task.run(); }).then(task.resolve, task.reject).finally(() => {
        this.active.delete(task.id);
        this.drain();
      });
    }
  }
}

export const HEALTH_CHECK_CONCURRENCY = 4;
export const healthCheckQueue = new HealthCheckQueue(HEALTH_CHECK_CONCURRENCY);
