import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../../src/state-manager.js";
import type { PersistenceAdapter, StateSnapshot } from "../../src/types.js";

function makeSnapshot<T>(key: string, value: T): StateSnapshot<T> {
  return {
    key,
    value,
    updatedAt: Date.now(),
    timeTaken: 5,
  };
}

function mockAdapter(overrides: Partial<PersistenceAdapter> = {}): PersistenceAdapter {
  return {
    get: () => null as any,
    set: () => {},
    ...overrides,
  };
}

describe("StateManager", () => {
  describe("in-memory store and fetch", () => {
    let manager: StateManager;

    beforeEach(() => {
      manager = new StateManager();
    });

    it("should return null for unknown keys", async () => {
      const result = await manager.fetch("nonexistent");
      assert.equal(result, null);
    });

    it("should store and fetch a snapshot when storeState is true", async () => {
      const snap = makeSnapshot("usd", 750);
      await manager.store(snap, 1000, {
        inMemory: true,
        persistence: { enabled: false, adapter: null },
        history: { historyCycle: null, keepHistoryAfterSave: false, maxHistoryLength: 100 },
      });

      const fetched = await manager.fetch<number>("usd");
      assert.deepEqual(fetched?.value, 750);
      assert.equal(fetched?.key, "usd");
    });

    it("should NOT store in memory when storeState is false", async () => {
      const snap = makeSnapshot("usd", 750);
      await manager.store(snap, 1000, {
        inMemory: false,
        persistence: { enabled: false, adapter: null },
        history: { historyCycle: null, keepHistoryAfterSave: false, maxHistoryLength: 100 },
      });

      const fetched = await manager.fetch("usd");
      assert.equal(fetched, null);
    });

    it("should overwrite existing snapshot for same key", async () => {
      await manager.store(makeSnapshot("usd", 750), 1000, {
        inMemory: true,
        persistence: { enabled: false, adapter: null },
        history: { historyCycle: null, keepHistoryAfterSave: false, maxHistoryLength: 100 },
      });
      await manager.store(makeSnapshot("usd", 800), 1000, {
        inMemory: true,
        persistence: { enabled: false, adapter: null },
        history: { historyCycle: null, keepHistoryAfterSave: false, maxHistoryLength: 100 },
      });

      const fetched = await manager.fetch<number>("usd");
      assert.equal(fetched?.value, 800);
    });
  });

  describe("delete", () => {
    it("should remove snapshot for a key", async () => {
      const manager = new StateManager();
      await manager.store(makeSnapshot("usd", 750), 1000, {
        inMemory: true,
        persistence: { enabled: false, adapter: null },
        history: { historyCycle: null, keepHistoryAfterSave: false, maxHistoryLength: 100 },
      });

      manager.delete("usd");
      const result = await manager.fetch("usd");
      assert.equal(result, null);
    });

    it("should not throw when deleting a nonexistent key", () => {
      const manager = new StateManager();
      assert.doesNotThrow(() => manager.delete("nope"));
    });
  });

  describe("clear", () => {
    it("should remove all snapshots", async () => {
      const manager = new StateManager();
      await manager.store(makeSnapshot("usd", 750), 1000, {
        inMemory: true,
        persistence: { enabled: false, adapter: null },
        history: { historyCycle: null, keepHistoryAfterSave: false, maxHistoryLength: 100 },
      });
      await manager.store(makeSnapshot("eur", 900), 1000, {
        inMemory: true,
        persistence: { enabled: false, adapter: null },
        history: { historyCycle: null, keepHistoryAfterSave: false, maxHistoryLength: 100 },
      });

      manager.clear();

      assert.equal(await manager.fetch("usd"), null);
      assert.equal(await manager.fetch("eur"), null);
    });
  });

  describe("persistence adapter", () => {
    it("should call adapter.set on store", async () => {
      const setCalls: { key: string; value: unknown; ttl: number }[] = [];

      const adapter = mockAdapter({
        set: (key, value, ttl) => {
          setCalls.push({ key, value, ttl: ttl! });
        },
      });

      const manager = new StateManager(adapter);
      await manager.store(makeSnapshot("usd", 750), 1000, {
        inMemory: false,
        persistence: { enabled: true, adapter: null },
        history: { historyCycle: null, keepHistoryAfterSave: false, maxHistoryLength: 100 },
      });

      assert.equal(setCalls.length, 1);
      assert.equal(setCalls[0].key, "usd");
      assert.equal((setCalls[0].value as any).value, 750);
      /* TTL should be 1000 * 1.2 = 1200 */
      assert.equal(setCalls[0].ttl, 1200);
    });

    it("should fall back to adapter.get when not in memory", async () => {
      const adapter = mockAdapter({
        get: (_key) => ({ key: _key, value: 999, updatedAt: 0, timeTaken: 0 } as any),
      });

      const manager = new StateManager(adapter);
      const result = await manager.fetch<number>("usd");
      assert.equal(result?.value, 999);
    });

    it("should prefer in-memory over persistence", async () => {
      const adapter = mockAdapter({
        get: () => ({ key: "usd", value: 999, updatedAt: 0, timeTaken: 0 } as any),
      });

      const manager = new StateManager(adapter);
      await manager.store(makeSnapshot("usd", 750), 1000, {
        inMemory: true,
        persistence: { enabled: true, adapter: null },
        history: { historyCycle: null, keepHistoryAfterSave: false, maxHistoryLength: 100 },
      });

      const result = await manager.fetch<number>("usd");
      assert.equal(result?.value, 750);
    });
  });

  describe("history", () => {
    it("should batch and flush history when cycle is reached", async () => {
      const historyFlushes: { key: string; entries: unknown[] }[] = [];

      const adapter = mockAdapter({
        addHistory: (key, entries) => {
          historyFlushes.push({ key, entries: [...entries] });
        },
      });

      const manager = new StateManager(adapter);

      const config = {
        inMemory: false,
        persistence: { enabled: true, adapter: null },
        history: {
          historyCycle: 3,
          keepHistoryAfterSave: false,
          maxHistoryLength: 100,
        },
      };

      await manager.store(makeSnapshot("usd", 1), 1000, config);
      await manager.store(makeSnapshot("usd", 2), 1000, config);
      assert.equal(historyFlushes.length, 0);

      await manager.store(makeSnapshot("usd", 3), 1000, config);
      assert.equal(historyFlushes.length, 1);
      assert.equal(historyFlushes[0].entries.length, 3);
    });

    it("should clear history queue after flush when keepHistoryAfterSave is false", async () => {
      const historyFlushes: unknown[][] = [];
      const adapter = mockAdapter({
        addHistory: (_key, entries) => { historyFlushes.push([...entries]); },
      });

      const manager = new StateManager(adapter);

      const config = {
        inMemory: false,
        persistence: { enabled: true, adapter: null },
        history: {
          historyCycle: 2,
          keepHistoryAfterSave: false,
          maxHistoryLength: 100,
        },
      };

      await manager.store(makeSnapshot("usd", 1), 1000, config);
      await manager.store(makeSnapshot("usd", 2), 1000, config);
      assert.equal(historyFlushes.length, 1);

      /* Next cycle starts fresh */
      await manager.store(makeSnapshot("usd", 3), 1000, config);
      await manager.store(makeSnapshot("usd", 4), 1000, config);
      assert.equal(historyFlushes.length, 2);
      assert.equal(historyFlushes[1].length, 2);
    });

    it("should keep history queue after flush when keepHistoryAfterSave is true, bounded by maxHistoryLength", async () => {
      const historyFlushes: unknown[][] = [];
      const adapter = mockAdapter({
        addHistory: (_key, entries) => { historyFlushes.push([...entries]); },
      });

      const manager = new StateManager(adapter);

      const config = {
        inMemory: false,
        persistence: { enabled: true, adapter: null },
        history: {
          historyCycle: 2,
          keepHistoryAfterSave: true,
          maxHistoryLength: 3,
        },
      };

      await manager.store(makeSnapshot("usd", 1), 1000, config);
      await manager.store(makeSnapshot("usd", 2), 1000, config);
      
      assert.equal(historyFlushes.length, 1);
      const history1 = manager.getHistory<number>("usd");
      assert.equal(history1.length, 2);
      assert.equal(history1[0].value, 1);
      assert.equal(history1[1].value, 2);

      await manager.store(makeSnapshot("usd", 3), 1000, config);
      const history2 = manager.getHistory<number>("usd");
      assert.equal(history2.length, 3);

      await manager.store(makeSnapshot("usd", 4), 1000, config);
      const history3 = manager.getHistory<number>("usd");
      assert.equal(history3.length, 3);
      assert.equal(history3[0].value, 2);
      assert.equal(history3[1].value, 3);
      assert.equal(history3[2].value, 4);
    });

    it("should keep history in memory only if adapter does not implement addHistory", async () => {
      /* Adapter without addHistory */
      const adapter = mockAdapter({});
      const manager = new StateManager(adapter);

      const config = {
        inMemory: true,
        persistence: { enabled: true, adapter: null },
        history: {
          historyCycle: 2,
          keepHistoryAfterSave: false,
          maxHistoryLength: 5,
        },
      };

      await manager.store(makeSnapshot("usd", 1), 1000, config);
      await manager.store(makeSnapshot("usd", 2), 1000, config);

      const history = manager.getHistory<number>("usd");
      /* Since adapter lacks addHistory, it stays in memory and doesn't flush/clear */
      assert.equal(history.length, 2);
      assert.equal(history[0].value, 1);
      assert.equal(history[1].value, 2);
    });
  });
});
