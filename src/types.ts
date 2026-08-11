/**
 * Configuration options for the StatePulse instance.
 */
export interface StatePulseConfig {
  /**
   * Optional custom persistence adapter to store node values and history externally.
   */
  persistence?: PersistenceAdapter | null;

  /**
   * Whether to automatically attach SIGINT/SIGTERM listener handlers to the global process object.
   */
  enableSignalHandling?: boolean;
}

/**
 * Interface that persistence drivers must implement to integrate with StatePulse.
 */
export interface PersistenceAdapter {
  /**
   * Retrieves the stored value for a given key.
   */
  get<T>(key: string): Promise<T | null> | T;

  /**
   * Stores a value for a key with an optional time-to-live in milliseconds.
   */
  set(key: string, value: unknown, ttl?: number): Promise<void> | void;

  /**
   * Optional method to store an array of history snapshots.
   */
  addHistory?(key: string, entries: unknown[]): Promise<void> | void;
}

/**
 * Node-specific persistence configuration options.
 */
export interface NodePersistenceConfig {
  /**
   * Whether to enable persistence for this node.
   * If true, requires either a local adapter to be defined or a global persistence adapter to be set.
   * If false, explicitly disables persistence for this node.
   */
  enabled?: boolean;

  /**
   * Optional node-specific persistence adapter to override the global one.
   */
  adapter?: PersistenceAdapter | null;
}

/**
 * Node-specific configuration block for state storage, memory, and persistence options.
 */
export interface NodeStateConfig {
  /**
   * Whether to save state snapshots in the local in-memory store. Defaults to true.
   */
  inMemory?: boolean;

  /**
   * Node-specific persistence configuration block.
   */
  persistence?: NodePersistenceConfig;

  /**
   * Node-specific history configurations.
   */
  history?: {
    /**
     * Number of execution cycles before flushing accumulated history to persistence.
     * If null, history is never flushed to persistence.
     */
    historyCycle?: number | null;

    /**
     * Whether to retain snapshots in the local in-memory history queue after flushing to persistence.
     */
    keepHistoryAfterSave?: boolean;

    /**
     * Strict upper bound for the in-memory history array to prevent memory leaks or OOM. Defaults to 100.
     */
    maxHistoryLength?: number;
  };
}

/**
 * Internal fully-validated representation of a State Node.
 */
export interface StateNode<T> {
  key: string;
  run: (signal?: AbortSignal) => T | Promise<T>;
  logErrors: boolean | ((error: string) => void);
  refreshPolicy: {
    intervalMs: number;
    overlapAction: "skip" | "overlap";
  };
  retryPolicy: {
    count: number;
  };
  stateConfig: Required<Omit<NodeStateConfig, "persistence" | "history">> & {
    persistence: Required<NodePersistenceConfig>;
    history: Required<NonNullable<NodeStateConfig["history"]>>;
  };
}

/**
 * Options used to register a new state node.
 */
export interface RegisterNodeConfig<T> {
  /**
   * Unique identifier key for the state node.
   */
  key: string;

  /**
   * The execution function called periodically. Receives an AbortSignal to handle cancellations.
   */
  run: (signal?: AbortSignal) => T | Promise<T>;

  /**
   * How errors should be handled. Can be true (logs to stderr), false (ignores), or a custom callback function.
   */
  logErrors?: boolean | ((error: string) => void);

  /**
   * Policies describing execution cadence and overflow handling.
   */
  refreshPolicy?: {
    /**
     * Duration in milliseconds between executions. Must be strictly positive (> 0).
     */
    intervalMs?: number;

    /**
     * Strategy when task run-time exceeds the interval. "skip" to drop missed cycles, "overlap" to run concurrently.
     */
    overlapAction?: "skip" | "overlap";
  };

  /**
   * Policies describing failure recovery behaviors.
   */
  retryPolicy?: {
    /**
     * Maximum retry attempts on failure before logging/reporting the error.
     */
    count?: number;
  };

  /**
   * State and persistence options for this node.
   */
  stateConfig?: NodeStateConfig;
}

/**
 * Structure of a completed state execution snapshot.
 */
export interface StateSnapshot<T> {
  /**
   * The returned result of a successful run function execution.
   */
  value: T;

  /**
   * Millisecond epoch timestamp when this state was updated.
   */
  updatedAt: number;

  /**
   * The key corresponding to this state node.
   */
  key: string;

  /**
   * Execution time of the run function in milliseconds.
   */
  timeTaken: number;
}
