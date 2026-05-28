import type { StatePulseConfig, PersistenceAdapter, StateNode, RegisterNodeConfig } from "./types.js";

/**
 * Default library configuration parameters.
 */
export const DEFAULT_PULSE_CONFIG = {
  historyCycle: null,
  keepHistoryAfterSave: false,
  maxHistoryLength: 100,
  enableSignalHandling: true,
} as const;

/**
 * Default individual state node configuration parameters.
 */
export const DEFAULT_NODE_CONFIG = {
  storeState: true,
  logErrors: false,
  refreshIntervalMs: 5 * 60 * 1000,
  overlapAction: "skip",
  retryCount: 3,
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

  if (merged.persistence !== undefined) {
    if (!isPersistenceAdapter(merged.persistence)) {
      throw new TypeError(
        "Persistence adapter must be an object implementing get(key) and set(key, value, ttl?), with an optional addHistory(key, entries) function",
      );
    }
  }

  if (merged.historyCycle !== null) {
    if (!Number.isInteger(merged.historyCycle) || merged.historyCycle < 1) {
      throw new TypeError("historyCycle must be a positive integer or null");
    }
  }

  if (typeof merged.keepHistoryAfterSave !== "boolean") {
    throw new TypeError("keepHistoryAfterSave must be a boolean");
  }

  if (!Number.isInteger(merged.maxHistoryLength) || merged.maxHistoryLength < 1) {
    throw new TypeError("maxHistoryLength must be a positive integer");
  }

  if (merged.historyCycle !== null && merged.historyCycle > merged.maxHistoryLength) {
    throw new TypeError("historyCycle must be less than or equal to maxHistoryLength");
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
export function validateAndFillNode<T>(node: RegisterNodeConfig<T>): StateNode<T> {
  if (typeof node.key !== "string") {
    throw new TypeError("Node key must be a string");
  }

  if (typeof node.run !== "function") {
    throw new TypeError(`Node "${node.key}" run property must be a function`);
  }

  const storeState = node.storeState ?? DEFAULT_NODE_CONFIG.storeState;
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

  return {
    key: node.key,
    run: node.run,
    storeState,
    logErrors,
    refreshPolicy: {
      intervalMs,
      overlapAction,
    },
    retryPolicy: {
      count,
    },
  };
}
