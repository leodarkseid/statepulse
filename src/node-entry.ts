import type { StateNode } from "./types.js";

/**
 * Manages the execution lifecycle, timing, and abort signaling of a registered state node.
 */
export class NodeEntry<T> {
  #timer: NodeJS.Timeout | null = null;
  #abortController: AbortController;
  #running = false;
  #stopped = false;

  constructor(readonly node: StateNode<T>) {
    this.#abortController = new AbortController();
  }

  /**
   * Retrieves the abort signal associated with this node's current lifecycle.
   */
  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  /**
   * Whether the runner is currently executing.
   */
  get running(): boolean {
    return this.#running;
  }

  /**
   * Whether this node's loop has been stopped.
   */
  get stopped(): boolean {
    return this.#stopped;
  }

  /**
   * Marks the execution state as active.
   */
  markRunning(): void {
    this.#running = true;
  }

  /**
   * Marks the execution state as idle.
   */
  markIdle(): void {
    this.#running = false;
  }

  /**
   * Schedules a delayed callback invocation. Safely handles invalid or negative delay ranges.
   */
  schedule(callback: () => void, delayMs: number): void {
    this.clearTimer();

    if (this.#stopped) return;

    let finalDelay = delayMs;
    if (!Number.isFinite(finalDelay) || finalDelay < 0) {
      finalDelay = 0;
    }

    this.#timer = setTimeout(() => {
      this.#timer = null;
      callback();
    }, finalDelay);

    this.#timer.unref();
  }

  /**
   * Cancels any pending scheduled timer, triggers the abort signal, and flags the entry as stopped.
   */
  stop(): void {
    this.#stopped = true;
    this.clearTimer();
    this.#abortController.abort();
  }

  private clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
