import type { PersistenceAdapter, StateSnapshot } from "./types.js";

/**
 * Orchestrates local state caches, circular history queues, and persistence driver operations.
 */
export class StateManager {
  #snapshotsArray = new Map<string, StateSnapshot<unknown>[]>();
  readonly #snapshots = new Map<string, StateSnapshot<unknown>>();

  constructor(
    private readonly p?: PersistenceAdapter,
    private historyCycle: number | null = null,
    private keepHistoryAfterSave = false,
    private maxHistoryLength = 100,
  ) { }

  /**
   * Resets all in-memory snapshot caches and history arrays.
   */
  clear(): void {
    this.#snapshots.clear();
    this.#snapshotsArray.clear();
  }

  /**
   * Removes all cached snapshots and history records for a key.
   */
  delete(key: string): void {
    this.#snapshots.delete(key);
    this.#snapshotsArray.delete(key);
  }

  /**
   * Returns a shallow copy of a node's in-memory history buffer to ensure immutability.
   */
  getHistory<T>(key: string): StateSnapshot<T>[] {
    const queue = this.#snapshotsArray.get(key);
    if (!queue) return [];
    return queue.slice() as StateSnapshot<T>[];
  }

  /**
   * Stores a new state snapshot. Integrates local memory, persistence drivers, 
   * rolling queue evictions, and custom persistence history cycle flush policies.
   */
  async store<T>(
    snapshot: StateSnapshot<T>,
    ttl: number,
    storeState = false,
  ): Promise<void> {
    const intervalMs = ttl * 1.2;

    if (storeState) {
      this.#snapshots.set(snapshot.key, snapshot);
    }

    if (this.p) {
      await this.p.set(snapshot.key, snapshot.value, intervalMs);
    }

    let queue = this.#snapshotsArray.get(snapshot.key);
    if (!queue) {
      queue = [];
      this.#snapshotsArray.set(snapshot.key, queue);
    }
    queue.push(snapshot);

    if (queue.length > this.maxHistoryLength) {
      queue.shift();
    }

    if (
      typeof this.historyCycle === "number" &&
      typeof this.p?.addHistory === "function"
    ) {
      if (queue.length >= this.historyCycle) {
        await this.p.addHistory(snapshot.key, [...queue]);

        if (!this.keepHistoryAfterSave) {
          this.#snapshotsArray.set(snapshot.key, []);
        }
      }
    }
  }

  /**
   * Fetches the latest snapshot for a key, prioritizing local memory before querying persistence.
   */
  async fetch<T>(key: string): Promise<StateSnapshot<T> | null> {
    const inMem = this.#snapshots.get(key);

    if (inMem) {
      return inMem as StateSnapshot<T>;
    }

    if (this.p) {
      const fromPersistence = await this.p.get(key);
      if (fromPersistence) {
        return fromPersistence as StateSnapshot<T>;
      }
    }

    return null;
  }
}
