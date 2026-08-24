/**
 * Serializes asynchronous work by key without coupling unrelated keys. A rejected task does not
 * poison later work for the same key.
 */
export class KeyedAsyncSequencer<Key> {
  #tails = new Map<Key, Promise<void>>();

  async run<Result>(key: Key, task: () => Promise<Result>): Promise<Result> {
    let prior = this.#tails.get(key) ?? Promise.resolve();
    let result = prior.catch(() => {}).then(task);
    // Store a non-rejecting tail: one failed task must not poison later work for the same key.
    let tail = result.then(() => {}, () => {});
    this.#tails.set(key, tail);
    try {
      return await result;
    } finally {
      // A later task may already have replaced this tail while `result` was settling.
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
