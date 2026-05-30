import type { PersistenceAdapter, StateSnapshot, NodeStateConfig } from "./types.js";

type ValidatedStateConfig = Required<Omit<NodeStateConfig, "persistence" | "history">> & {
  persistence: Required<NonNullable<NodeStateConfig["persistence"]>>;
  history: Required<NonNullable<NodeStateConfig["history"]>>;
};

/**
 * Orchestrates local state caches, circular history queues, and persistence driver operations.
 */
export class StateManager {
  #snapshotsArray = new Map<string, StateSnapshot<unknown>[]>();
  readonly #snapshots = new Map<string, StateSnapshot<unknown>>();

  constructor(
    private readonly globalPersistence?: PersistenceAdapter | null,
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
   * Stores a new state snapshot. Integrates local memory, active persistence driver, 
   * rolling queue evictions, and custom persistence history cycle flush policies.
   */
  async store<T>(
    snapshot: StateSnapshot<T>,
    ttl: number,
    stateConfig: ValidatedStateConfig,
  ): Promise<void> {
    const intervalMs = ttl * 1.2;

    if (stateConfig.inMemory) {
      this.#snapshots.set(snapshot.key, snapshot);
    }

    const activeAdapter = stateConfig.persistence.enabled
      ? (stateConfig.persistence.adapter ?? this.globalPersistence)
      : null;

    if (activeAdapter) {
      await activeAdapter.set(snapshot.key, snapshot.value, intervalMs);
    }

    let queue = this.#snapshotsArray.get(snapshot.key);
    if (!queue) {
      queue = [];
      this.#snapshotsArray.set(snapshot.key, queue);
    }
    queue.push(snapshot);

    const maxHistoryLength = stateConfig.history.maxHistoryLength;
    if (queue.length > maxHistoryLength) {
      queue.shift();
    }

    const historyCycle = stateConfig.history.historyCycle;
    if (
      typeof historyCycle === "number" &&
      activeAdapter &&
      typeof activeAdapter.addHistory === "function"
    ) {
      if (queue.length >= historyCycle) {
        await activeAdapter.addHistory(snapshot.key, [...queue]);

        if (!stateConfig.history.keepHistoryAfterSave) {
          this.#snapshotsArray.set(snapshot.key, []);
        }
      }
    }
  }

  /**
   * Fetches the latest snapshot for a key, prioritizing local memory before querying active persistence.
   */
  async fetch<T>(key: string, activeAdapter?: PersistenceAdapter | null): Promise<StateSnapshot<T> | null> {
    const inMem = this.#snapshots.get(key);

    if (inMem) {
      return inMem as StateSnapshot<T>;
    }

    const adapterToQuery = activeAdapter !== undefined ? activeAdapter : this.globalPersistence;
    if (adapterToQuery) {
      const fromPersistence = await adapterToQuery.get(key);
      if (fromPersistence) {
        return fromPersistence as StateSnapshot<T>;
      }
    }

    return null;
  }
}
