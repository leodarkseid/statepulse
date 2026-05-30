import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NodeEntry } from "../../src/node-entry.js";
import type { StateNode } from "../../src/types.js";

function makeNode(overrides: Partial<StateNode<string>> = {}): StateNode<string> {
  return {
    key: "test-key",
    run: () => "value",
    logErrors: false,
    refreshPolicy: { intervalMs: 1000, overlapAction: "skip" },
    retryPolicy: { count: 3 },
    stateConfig: {
      inMemory: true,
      persistence: {
        enabled: false,
        adapter: null,
      },
      history: {
        historyCycle: null,
        keepHistoryAfterSave: false,
        maxHistoryLength: 100,
      },
    },
    ...overrides,
  };
}

describe("NodeEntry", () => {
  let entry: NodeEntry<string>;

  beforeEach(() => {
    entry = new NodeEntry(makeNode());
  });

  describe("initial state", () => {
    it("should not be running", () => {
      assert.equal(entry.running, false);
    });

    it("should not be stopped", () => {
      assert.equal(entry.stopped, false);
    });

    it("should have a valid abort signal", () => {
      assert.ok(entry.signal instanceof AbortSignal);
      assert.equal(entry.signal.aborted, false);
    });

    it("should expose the node", () => {
      assert.equal(entry.node.key, "test-key");
    });
  });

  describe("markRunning / markIdle", () => {
    it("should set running to true", () => {
      entry.markRunning();
      assert.equal(entry.running, true);
    });

    it("should set running back to false", () => {
      entry.markRunning();
      entry.markIdle();
      assert.equal(entry.running, false);
    });
  });

  describe("schedule", () => {
    it("should fire the callback after the delay", async () => {
      let called = false;
      entry.schedule(() => { called = true; }, 10);

      await new Promise((r) => setTimeout(r, 50));
      assert.equal(called, true);
    });

    it("should clear the previous timer when scheduling again", async () => {
      let firstCalled = false;
      let secondCalled = false;

      entry.schedule(() => { firstCalled = true; }, 50);
      entry.schedule(() => { secondCalled = true; }, 10);

      await new Promise((r) => setTimeout(r, 100));
      assert.equal(firstCalled, false, "first callback should not fire");
      assert.equal(secondCalled, true, "second callback should fire");
    });

    it("should not schedule if stopped", async () => {
      let called = false;
      entry.stop();
      entry.schedule(() => { called = true; }, 10);

      await new Promise((r) => setTimeout(r, 50));
      assert.equal(called, false);
    });

    it("should handle NaN delay by defaulting to 0", async () => {
      let called = false;
      entry.schedule(() => { called = true; }, NaN);

      await new Promise((r) => setTimeout(r, 50));
      assert.equal(called, true);
    });

    it("should handle negative delay by defaulting to 0", async () => {
      let called = false;
      entry.schedule(() => { called = true; }, -100);

      await new Promise((r) => setTimeout(r, 50));
      assert.equal(called, true);
    });
  });

  describe("stop", () => {
    it("should set stopped to true", () => {
      entry.stop();
      assert.equal(entry.stopped, true);
    });

    it("should abort the signal", () => {
      entry.stop();
      assert.equal(entry.signal.aborted, true);
    });

    it("should clear a pending timer", async () => {
      let called = false;
      entry.schedule(() => { called = true; }, 50);
      entry.stop();

      await new Promise((r) => setTimeout(r, 100));
      assert.equal(called, false);
    });

    it("should be idempotent", () => {
      entry.stop();
      entry.stop();
      assert.equal(entry.stopped, true);
    });
  });
});
