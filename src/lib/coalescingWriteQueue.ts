export type WriteFailureHandler<Key, Value> = (error: unknown, key: Key, value: Value) => void;

export class CoalescingWriteQueue<Key, Value> {
  readonly #pending = new Map<Key, Value>();
  readonly #write: (key: Key, value: Value) => Promise<void>;
  readonly #onFailure?: WriteFailureHandler<Key, Value>;
  #running?: Promise<void>;

  constructor(
    write: (key: Key, value: Value) => Promise<void>,
    onFailure?: WriteFailureHandler<Key, Value>,
  ) {
    this.#write = write;
    this.#onFailure = onFailure;
  }

  enqueue(key: Key, value: Value): void {
    this.#pending.set(key, value);
    this.#start();
  }

  async flush(): Promise<void> {
    while (this.#running || this.#pending.size > 0) {
      this.#start();
      await this.#running;
    }
  }

  #start(): void {
    if (this.#running || this.#pending.size === 0) return;
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
      if (this.#pending.size > 0) this.#start();
    });
  }

  async #drain(): Promise<void> {
    while (this.#pending.size > 0) {
      const next = this.#pending.entries().next().value as [Key, Value] | undefined;
      if (!next) return;
      const [key, value] = next;
      this.#pending.delete(key);
      try {
        await this.#write(key, value);
      } catch (error) {
        this.#onFailure?.(error, key, value);
      }
    }
  }
}
