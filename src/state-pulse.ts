import { NodeEntry } from "./node-entry.js";
import { StateManager } from "./state-manager.js";
import type {
  StatePulseConfig,
  RegisterNodeConfig,
  StateSnapshot,
} from "./types.js";
import { runAndTime } from "./utils.js";
import {
  validateAndFillPulseConfig,
  validateAndFillNode,
} from "./config-validator.js";

const pulseRegistry = new FinalizationRegistry<{ signal: NodeJS.Signals; handler: () => void }[]>((handlers) => {
  for (const { signal, handler } of handlers) {
    process.off(signal, handler);
  }
});

/**
 * Main periodic background polling and state cache engine.
 */
export class StatePulse {
  private readonly intervalMs = 5 * 60 * 1000;
  readonly #state: StateManager;
  readonly #nodes = new Map<string, NodeEntry<unknown>>();
  #terminated = false;

  readonly #signalHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(config?: Partial<StatePulseConfig>) {
    const validated = validateAndFillPulseConfig(config);
    this.#state = new StateManager(
      validated.persistence,
      validated.historyCycle,
      validated.keepHistoryAfterSave ?? false,
      validated.maxHistoryLength ?? 100,
    );

    this.#enableGracefulShutdown(validated.enableSignalHandling ?? true);
  }

  #enableGracefulShutdown(enable: boolean): void {
    if (!enable) return;

    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const ref = new WeakRef(this);
    const handlersToRegister: { signal: NodeJS.Signals; handler: () => void }[] = [];

    for (const signal of signals) {
      const handler = (): void => {
        const instance = ref.deref();
        if (instance) {
          instance.terminate();
        }
        process.kill(process.pid, signal);
      };
      this.#signalHandlers.set(signal, handler);
      process.once(signal, handler);
      handlersToRegister.push({ signal, handler });
    }

    pulseRegistry.register(this, handlersToRegister, this);
  }

  /**
   * Gracefully cancels all running schedulers, signals cancellation, and purges all local states.
   */
  terminate(): void {
    this.#terminated = true;

    pulseRegistry.unregister(this);

    for (const [signal, handler] of this.#signalHandlers) {
      process.off(signal, handler);
    }
    this.#signalHandlers.clear();

    for (const entry of this.#nodes.values()) {
      entry.stop();
    }
    this.#nodes.clear();
    this.#state.clear();
  }

  /**
   * Registers a new state node configuration and starts its polling loop.
   * @throws {Error} If StatePulse is terminated or key is already registered.
   */
  async register<T>(node: RegisterNodeConfig<T>): Promise<void> {
    if (this.#terminated) {
      throw new Error("StatePulse has been terminated");
    }
    const validated = validateAndFillNode(node);
    if (this.#nodes.has(validated.key)) {
      throw new Error(`Node with key "${validated.key}" is already registered`);
    }

    const entry = new NodeEntry(validated);
    this.#nodes.set(validated.key, entry);

    const expectedTick = Date.now();
    await this.#startLoop(entry, expectedTick);
  }

  /**
   * Retrieves the latest stored state snapshot for a registered node.
   * @throws {Error} If StatePulse is terminated.
   */
  async get<T>(key: string): Promise<StateSnapshot<T> | null> {
    if (this.#terminated) {
      throw new Error("StatePulse has been terminated");
    }
    return await this.#state.fetch<T>(key);
  }

  /**
   * Retrieves an immutable clone of the chronological history queue for a key.
   * @throws {Error} If StatePulse is terminated.
   */
  getHistory<T>(key: string): StateSnapshot<T>[] {
    if (this.#terminated) {
      throw new Error("StatePulse has been terminated");
    }
    return this.#state.getHistory<T>(key);
  }

  /**
   * Stops polling execution and purges state/history cached for a specific key.
   * @throws {Error} If StatePulse is terminated.
   */
  unregister(key: string): void {
    if (this.#terminated) {
      throw new Error("StatePulse has been terminated");
    }

    const entry = this.#nodes.get(key);
    if (entry) {
      entry.stop();
      this.#nodes.delete(key);
      this.#state.delete(key);
    }
  }

  /**
   * List of registered keys whose runner callbacks are actively executing.
   */
  get activeRuns(): string[] {
    const keys: string[] = [];
    for (const [key, entry] of this.#nodes) {
      if (entry.running) {
        keys.push(key);
      }
    }
    return keys;
  }

  async #startLoop<T>(
    entry: NodeEntry<T>,
    expectedTick: number,
    retryCount = 0,
  ): Promise<void> {
    if (entry.stopped) return;

    entry.markRunning();
    const execution = await runAndTime(() => entry.node.run(entry.signal));
    entry.markIdle();

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (entry.stopped) return;

    if (!execution.ok) {
      if (retryCount < entry.node.retryPolicy.count) {
        return this.#startLoop(entry, expectedTick, retryCount + 1);
      }

      this.#log(entry.node.logErrors, execution.error);
    } else {
      const { result, time } = execution;

      const snapshot: StateSnapshot<T> = {
        value: result,
        updatedAt: Date.now(),
        key: entry.node.key,
        timeTaken: time,
      };

      const stateUpdate = await runAndTime(() =>
        this.#state.store(
          snapshot,
          entry.node.refreshPolicy.intervalMs,
          entry.node.storeState,
        ),
      );

      if (!stateUpdate.ok) {
        this.#log(entry.node.logErrors, stateUpdate.error);
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (entry.stopped) return;
    }

    const interval = entry.node.refreshPolicy.intervalMs;

    let nextExpectedTick = expectedTick + interval;
    let timeUntilNextTick = nextExpectedTick - Date.now();

    if (timeUntilNextTick <= 0) {
      if (entry.node.refreshPolicy.overlapAction === "overlap") {
        timeUntilNextTick = 0;
      } else {
        const missedCycles = Math.ceil(Math.abs(timeUntilNextTick) / interval);
        timeUntilNextTick = interval * missedCycles + timeUntilNextTick;
        nextExpectedTick = Date.now() + timeUntilNextTick;
      }
    }

    entry.schedule(
      () => { void this.#startLoop(entry, nextExpectedTick); },
      timeUntilNextTick,
    );
  }

  #log(
    logErrors: boolean | ((error: string) => void) | undefined = false,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    if (logErrors === true) {
      console.error(message);
    }
    if (typeof logErrors === "function") {
      logErrors(message);
    }
  }
}
