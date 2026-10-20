export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.tails.set(key, current);
    void current.then(
      () => this.deleteIfCurrent(key, current),
      () => this.deleteIfCurrent(key, current),
    );
    return current;
  }

  /**
   * Runs `task` serialized after this key's previous work, without linking the
   * queue tail to the task's completion. The returned promise always follows
   * `task` to completion; call `detach()` when the task must stop blocking the
   * key (for example after an execution timeout) so later messages and
   * `drain()` can proceed while the abandoned task still settles.
   */
  runDetached(
    key: string,
    task: () => Promise<void>,
  ): {
    finished: Promise<void>;
    detach(): void;
  } {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let detached = false;
    const current = previous.catch(() => undefined).then(task);
    this.tails.set(key, current);
    const cleanup = () => {
      if (!detached) this.deleteIfCurrent(key, current);
    };
    void current.then(cleanup, cleanup);
    return {
      finished: current,
      /** Detach the queue tail so later work for the key can start. */
      detach: () => {
        if (detached) return;
        detached = true;
        this.deleteIfCurrent(key, current);
      },
    };
  }

  /**
   * Runs `task` under this key's tail with a detach timer that is armed only
   * once the task actually starts. When `timeoutMs` elapses while the task is
   * still running, the tail moves off it so later messages for the key can
   * proceed; a task that settles first never detaches. The returned promise
   * always follows `task` to completion so channel backpressure is kept.
   */
  runWithStartTimeout(key: string, task: () => Promise<void>, timeoutMs: number): Promise<void> {
    if (timeoutMs === Number.POSITIVE_INFINITY) {
      return this.runDetached(key, task).finished;
    }
    let detach: (() => void) | undefined;
    const detached = this.runDetached(key, async () => {
      const timer = setTimeout(() => detach?.(), timeoutMs);
      try {
        await task();
      } finally {
        clearTimeout(timer);
      }
    });
    detach = detached.detach;
    return detached.finished;
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.tails.values());
  }

  private deleteIfCurrent(key: string, current: Promise<void>): void {
    if (this.tails.get(key) === current) this.tails.delete(key);
  }
}
