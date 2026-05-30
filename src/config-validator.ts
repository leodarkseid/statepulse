import type { StatePulseConfig, PersistenceAdapter, StateNode, RegisterNodeConfig } from "./types.js";

/**
 * Default library configuration parameters.
 */
export const DEFAULT_PULSE_CONFIG = {
  enableSignalHandling: true,
} as const;

/**
 * Default individual state node configuration parameters.
 */
export const DEFAULT_NODE_CONFIG = {
  inMemory: true,
  logErrors: false,
  refreshIntervalMs: 5 * 60 * 1000,
  overlapAction: "skip",
  retryCount: 3,
  historyCycle: null,
  keepHistoryAfterSave: false,
  maxHistoryLength: 100,
} as const;

/**
 * Custom type guard validating that a value fully conforms to the PersistenceAdapter interface.
 */
function isPersistenceAdapter(value: unknown): value is PersistenceAdapter {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.get !== "function") {
    return false;
  }
  if (typeof record.set !== "function") {
    return false;
  }
  if ("addHistory" in record && typeof record.addHistory !== "function") {
    return false;
  }

  return true;
}

/**
 * Validates the top-level configuration options and applies fallback defaults.
 * @throws {TypeError} If validation checks fail.
 */
export function validateAndFillPulseConfig(config?: Partial<StatePulseConfig>): StatePulseConfig {
  const merged = {
    ...DEFAULT_PULSE_CONFIG,
    ...config,
  };

  if (merged.persistence !== undefined && merged.persistence !== null) {
    if (!isPersistenceAdapter(merged.persistence)) {
      throw new TypeError(
        "Persistence adapter must be an object implementing get(key) and set(key, value, ttl?), with an optional addHistory(key, entries) function",
      );
    }
  }

  if (typeof merged.enableSignalHandling !== "boolean") {
    throw new TypeError("enableSignalHandling must be a boolean");
  }

  return merged;
}

/**
 * Validates state node options upon registration and applies fallback defaults.
 * @throws {TypeError} If validation checks fail.
 */
export function validateAndFillNode<T>(
  node: RegisterNodeConfig<T>,
  globalPersistence?: PersistenceAdapter | null,
): StateNode<T> {
  if (typeof node.key !== "string") {
    throw new TypeError("Node key must be a string");
  }

  if (typeof node.run !== "function") {
    throw new TypeError(`Node "${node.key}" run property must be a function`);
  }

  const logErrors = node.logErrors ?? DEFAULT_NODE_CONFIG.logErrors;

  const refreshPolicy = node.refreshPolicy ?? {};
  const intervalMs = refreshPolicy.intervalMs ?? DEFAULT_NODE_CONFIG.refreshIntervalMs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError(`Node "${node.key}" refreshPolicy.intervalMs must be a positive finite number`);
  }

  const overlapAction: "skip" | "overlap" = refreshPolicy.overlapAction ?? DEFAULT_NODE_CONFIG.overlapAction;

  const retryPolicy = node.retryPolicy ?? {};
  const count = retryPolicy.count ?? DEFAULT_NODE_CONFIG.retryCount;
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(`Node "${node.key}" retryPolicy.count must be a non-negative integer`);
  }

  /* Deep validate stateConfig */
  const rawStateConfig = node.stateConfig ?? {};
  const inMemory = rawStateConfig.inMemory ?? DEFAULT_NODE_CONFIG.inMemory;
  const rawPersistenceConfig = rawStateConfig.persistence ?? {};

  const hasGlobalAdapter = globalPersistence !== undefined && globalPersistence !== null;
  const adapter = rawPersistenceConfig.adapter ?? null;

  if (adapter !== null) {
    if (!isPersistenceAdapter(adapter)) {
      throw new TypeError(
        `Node "${node.key}" persistence adapter must be an object implementing get(key) and set(key, value, ttl?), with an optional addHistory(key, entries) function`,
      );
    }
  }

  let enabled = rawPersistenceConfig.enabled;
  if (enabled === undefined) {
    if (adapter !== null) {
      enabled = true;
    } else {
      enabled = hasGlobalAdapter;
    }
  }

  if (enabled) {
    const resolvedAdapter = adapter ?? globalPersistence;
    if (!resolvedAdapter) {
      throw new TypeError(
        `Cannot enable persistence for node "${node.key}" because neither a node-specific adapter nor a global persistence adapter is configured.`,
      );
    }
  }

  const rawHistory = rawStateConfig.history ?? {};
  const historyCycle = rawHistory.historyCycle !== undefined ? rawHistory.historyCycle : DEFAULT_NODE_CONFIG.historyCycle;
  const keepHistoryAfterSave = rawHistory.keepHistoryAfterSave ?? DEFAULT_NODE_CONFIG.keepHistoryAfterSave;
  const maxHistoryLength = rawHistory.maxHistoryLength ?? DEFAULT_NODE_CONFIG.maxHistoryLength;

  if (historyCycle !== null) {
    if (!Number.isInteger(historyCycle) || historyCycle < 1) {
      throw new TypeError(`Node "${node.key}" history.historyCycle must be a positive integer or null`);
    }
  }

  if (typeof keepHistoryAfterSave !== "boolean") {
    throw new TypeError(`Node "${node.key}" history.keepHistoryAfterSave must be a boolean`);
  }

  if (!Number.isInteger(maxHistoryLength) || maxHistoryLength < 1) {
    throw new TypeError(`Node "${node.key}" history.maxHistoryLength must be a positive integer`);
  }

  if (historyCycle !== null && historyCycle > maxHistoryLength) {
    throw new TypeError(`Node "${node.key}" history.historyCycle must be less than or equal to history.maxHistoryLength`);
  }

  /* Fail-fast safety validation:
     Throw TypeError if history is configured, but both local in-memory storage and persistence (with addHistory) are disabled. */
  const isHistorySpecified = rawStateConfig.history !== undefined;
  if (isHistorySpecified) {
    const activeAdapter = adapter ?? globalPersistence;
    const hasAdapterWithAddHistory = activeAdapter && typeof activeAdapter.addHistory === "function";
    const persistenceActive = enabled && hasAdapterWithAddHistory;

    if (!inMemory && !persistenceActive) {
      throw new TypeError(
        `Cannot configure history for node "${node.key}" when both in-memory storage and persistence with addHistory are disabled.`,
      );
    }
  }

  return {
    key: node.key,
    run: node.run,
    logErrors,
    refreshPolicy: {
      intervalMs,
      overlapAction,
    },
    retryPolicy: {
      count,
    },
    stateConfig: {
      inMemory,
      persistence: {
        enabled,
        adapter,
      },
      history: {
        historyCycle,
        keepHistoryAfterSave,
        maxHistoryLength,
      },
    },
  };
}
