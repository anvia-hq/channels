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

  async drain(): Promise<void> {
    await Promise.allSettled(this.tails.values());
  }

  private deleteIfCurrent(key: string, current: Promise<void>): void {
    if (this.tails.get(key) === current) this.tails.delete(key);
  }
}
