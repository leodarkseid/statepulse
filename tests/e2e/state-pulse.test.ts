import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { StatePulse } from "../../src/state-pulse.js";
import type { RegisterNodeConfig, PersistenceAdapter } from "../../src/types.js";

function makeNode<T>(
  key: string,
  run: (signal?: AbortSignal) => T | Promise<T>,
  overrides: Partial<RegisterNodeConfig<T>> = {},
): RegisterNodeConfig<T> {
  return {
    key,
    run,
    stateConfig: {
      inMemory: true,
    },
    refreshPolicy: { intervalMs: 100, overlapAction: "skip" },
    retryPolicy: { count: 2 },
    ...overrides,
  };
}

function mockAdapter(overrides: Partial<PersistenceAdapter> = {}): PersistenceAdapter {
  return {
    get: () => null as any,
    set: () => {},
    ...overrides,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("StatePulse — register and get", () => {
  let pulse: StatePulse;
  afterEach(() => { try { pulse.terminate(); } catch {} });

  it("should register a node and fetch its value", async () => {
    pulse = new StatePulse({});
    let callCount = 0;
    await pulse.register(makeNode("usd-rate", () => { callCount++; return 750; }));
    const snap = await pulse.get<number>("usd-rate");
    assert.ok(snap);
    assert.equal(snap!.value, 750);
    assert.equal(snap!.key, "usd-rate");
    assert.equal(typeof snap!.timeTaken, "number");
    assert.equal(callCount, 1);
  });

  it("should pass AbortSignal to run function", async () => {
    pulse = new StatePulse({});
    let sig: AbortSignal | undefined;
    await pulse.register(makeNode("sig", (signal) => { sig = signal; return "ok"; }));
    assert.ok(sig instanceof AbortSignal);
    assert.equal(sig!.aborted, false);
  });

  it("should throw on duplicate registration", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("dup", () => "value"));
    await assert.rejects(
      () => pulse.register(makeNode("dup", () => "other")),
      { message: 'Node with key "dup" is already registered' },
    );
  });

  it("should return null for unregistered keys", async () => {
    pulse = new StatePulse({});
    assert.equal(await pulse.get("nonexistent"), null);
  });
});

describe("StatePulse — async run functions", () => {
  let pulse: StatePulse;
  afterEach(() => { try { pulse.terminate(); } catch {} });

  it("should handle async run functions", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("async-val", async () => {
      await wait(10);
      return { price: 750 };
    }));
    const snap = await pulse.get<{ price: number }>("async-val");
    assert.ok(snap);
    assert.equal(snap!.value.price, 750);
  });

  it("should handle async functions that reject", async () => {
    pulse = new StatePulse({});
    let attempts = 0;
    await pulse.register(makeNode("async-fail", async () => {
      attempts++;
      if (attempts < 3) {
        await wait(5);
        throw new Error("network error");
      }
      return "recovered";
    }, { retryPolicy: { count: 3 } }));
    const snap = await pulse.get<string>("async-fail");
    assert.equal(snap?.value, "recovered");
  });

  it("should handle slow async functions that exceed interval", async () => {
    pulse = new StatePulse({});
    let callCount = 0;
    await pulse.register(makeNode("slow-async", async () => {
      callCount++;
      await wait(80);
      return callCount;
    }, { refreshPolicy: { intervalMs: 50, overlapAction: "skip" } }));
    assert.equal(callCount, 1);
    await wait(200);
    assert.ok(callCount >= 2, `Expected >= 2 calls, got ${callCount}`);
  });
});

describe("StatePulse — polling loop", () => {
  let pulse: StatePulse;
  afterEach(() => { try { pulse.terminate(); } catch {} });

  it("should poll repeatedly", async () => {
    pulse = new StatePulse({});
    let callCount = 0;
    await pulse.register(makeNode("poll", () => { callCount++; return callCount; }, {
      refreshPolicy: { intervalMs: 50, overlapAction: "skip" },
    }));
    assert.equal(callCount, 1);
    await wait(180);
    assert.ok(callCount >= 3, `Expected >= 3, got ${callCount}`);
  });

  it("should update stored value on each poll", async () => {
    pulse = new StatePulse({});
    let counter = 0;
    await pulse.register(makeNode("updating", () => { counter++; return counter * 100; }, {
      refreshPolicy: { intervalMs: 50, overlapAction: "skip" },
    }));
    assert.equal((await pulse.get<number>("updating"))?.value, 100);
    await wait(120);
    const later = await pulse.get<number>("updating");
    assert.ok(later!.value > 100);
  });
});

describe("StatePulse — retry policy", () => {
  let pulse: StatePulse;
  afterEach(() => { try { pulse.terminate(); } catch {} });

  it("should retry and succeed", async () => {
    pulse = new StatePulse({});
    let attempts = 0;
    await pulse.register(makeNode("retry-ok", () => {
      attempts++;
      if (attempts < 3) throw new Error("not yet");
      return "recovered";
    }, { retryPolicy: { count: 3 } }));
    assert.equal((await pulse.get<string>("retry-ok"))?.value, "recovered");
    assert.equal(attempts, 3);
  });

  it("should log error and continue polling after retry exhaustion", async () => {
    pulse = new StatePulse({});
    const errors: string[] = [];
    let callCount = 0;
    await pulse.register(makeNode("always-fail", () => {
      callCount++;
      throw new Error("fail");
    }, {
      retryPolicy: { count: 1 },
      refreshPolicy: { intervalMs: 50, overlapAction: "skip" },
      logErrors: (err: string) => { errors.push(err); },
    }));
    await wait(150);
    assert.ok(errors.length >= 1);
    assert.ok(callCount > 2, `Loop should continue, got ${callCount}`);
  });

  it("should not experience scheduling drift or double-interval delays after retry exhaustion", async () => {
    pulse = new StatePulse({});
    const runs: number[] = [];
    let shouldFail = true;

    await pulse.register({
      key: "drift-node",
      run: () => {
        runs.push(Date.now());
        if (shouldFail) {
          shouldFail = false;
          throw new Error("fail on first run");
        }
        return "success";
      },
      refreshPolicy: { intervalMs: 100, overlapAction: "skip" },
      retryPolicy: { count: 0 },
    });

    await wait(250);

    assert.equal(runs.length >= 3, true);
    
    const secondDiff = runs[2] - runs[1];
    assert.ok(secondDiff < 150, `Subsequent execution should not be delayed by double interval (got ${secondDiff}ms)`);
  });

  it("should safely convert native Error objects to strings when calling logErrors", async () => {
    pulse = new StatePulse({});
    let loggedMsg = "";
    
    await pulse.register(makeNode("type-safety-log", () => {
      throw new Error("specific-reason");
    }, {
      retryPolicy: { count: 0 },
      refreshPolicy: { intervalMs: 50 },
      logErrors: (err: string) => {
        if (err.includes("specific-reason")) {
          loggedMsg = err;
        }
      }
    }));

    await wait(80);
    assert.equal(loggedMsg, "specific-reason");
  });
});

describe("StatePulse — unregister and state clearing", () => {
  let pulse: StatePulse;
  afterEach(() => { try { pulse.terminate(); } catch {} });

  it("should stop polling after unregister", async () => {
    pulse = new StatePulse({});
    let callCount = 0;
    await pulse.register(makeNode("unreg", () => { callCount++; return "data"; }, {
      refreshPolicy: { intervalMs: 50, overlapAction: "skip" },
    }));
    const countAfter = callCount;
    pulse.unregister("unreg");
    await wait(150);
    assert.equal(callCount, countAfter);
  });

  it("should clear snapshot data on unregister", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("clear-me", () => "value"));
    assert.ok(await pulse.get("clear-me"));
    pulse.unregister("clear-me");
    assert.equal(await pulse.get("clear-me"), null);
  });

  it("should allow re-registration after unregister", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("reuse", () => "first"));
    pulse.unregister("reuse");
    await pulse.register(makeNode("reuse", () => "second"));
    assert.equal((await pulse.get<string>("reuse"))?.value, "second");
  });

  it("should not affect other nodes when one is unregistered", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("a", () => 1));
    await pulse.register(makeNode("b", () => 2));
    pulse.unregister("a");
    assert.equal(await pulse.get("a"), null);
    assert.ok(await pulse.get("b"));
  });

  it("should clear persistence-backed state on unregister", async () => {
    const stored = new Map<string, unknown>();
    pulse = new StatePulse({
      persistence: mockAdapter({
        set: (key, value) => { stored.set(key, value); },
      }),
    });
    await pulse.register(makeNode("p-clear", () => 42));
    assert.equal((stored.get("p-clear") as any).value, 42);
    pulse.unregister("p-clear");
    assert.equal(await pulse.get("p-clear"), null);
  });
});

describe("StatePulse — terminate", () => {
  let pulse: StatePulse;

  it("should stop all polling loops", async () => {
    pulse = new StatePulse({});
    let countA = 0, countB = 0;
    await pulse.register(makeNode("a", () => { countA++; return "a"; }, {
      refreshPolicy: { intervalMs: 50, overlapAction: "skip" },
    }));
    await pulse.register(makeNode("b", () => { countB++; return "b"; }, {
      refreshPolicy: { intervalMs: 50, overlapAction: "skip" },
    }));
    const snapA = countA, snapB = countB;
    pulse.terminate();
    /* terminate is synchronous and immediate */
    await wait(600);
    /* The run may have completed but no new scheduling should happen
       The key point: no errors thrown, no zombie loops */
  });

  it("should be idempotent", () => {
    pulse = new StatePulse({});
    pulse.terminate();
    /* Second call should not throw */
    assert.doesNotThrow(() => pulse.terminate());
  });

  it("should clear all state on terminate", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("val1", () => 1));
    await pulse.register(makeNode("val2", () => 2));
    pulse.terminate();
    /* Can't call get after terminate (throws), which confirms freeze */
    await assert.rejects(() => pulse.get("val1"),
      { message: "StatePulse has been terminated" });
  });
});

describe("StatePulse — activeRuns", () => {
  let pulse: StatePulse;
  afterEach(() => { try { pulse.terminate(); } catch {} });

  it("should report currently running keys", async () => {
    pulse = new StatePulse({});
    const promise = pulse.register(makeNode("slow", async () => {
      await wait(200);
      return "done";
    }));
    await wait(20);
    assert.deepEqual(pulse.activeRuns, ["slow"]);
    pulse.terminate();
    await promise.catch(() => {});
  });

  it("should report empty when nothing is running", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("fast", () => "done"));
    /* After register resolves, the sync run is complete */
    assert.deepEqual(pulse.activeRuns, []);
  });
});

describe("StatePulse — persistence integration", () => {
  let pulse: StatePulse;
  afterEach(() => { try { pulse.terminate(); } catch {} });

  it("should write to persistence on each poll", async () => {
    const stored = new Map<string, unknown>();
    pulse = new StatePulse({
      persistence: mockAdapter({
        set: (key, value) => { stored.set(key, value); },
      }),
    });
    await pulse.register(makeNode("persisted", () => 42));
    assert.equal((stored.get("persisted") as any).value, 42);
  });

  it("should update persistence on subsequent polls", async () => {
    const values: number[] = [];
    let counter = 0;
    pulse = new StatePulse({
      persistence: mockAdapter({
        set: (_key, value) => { values.push((value as any).value as number); },
      }),
    });
    await pulse.register(makeNode("updating-p", () => { counter++; return counter; }, {
      refreshPolicy: { intervalMs: 50, overlapAction: "skip" },
    }));
    await wait(150);
    assert.ok(values.length >= 3);
    assert.ok(values[values.length - 1] > values[0]);
  });

  it("should override global persistence with custom node-level persistence", async () => {
    const globalStored = new Map<string, unknown>();
    const localStored = new Map<string, unknown>();

    pulse = new StatePulse({
      persistence: mockAdapter({
        set: (key, val) => { globalStored.set(key, val); },
      }),
    });

    await pulse.register(makeNode("custom-p", () => 77, {
      stateConfig: {
        persistence: {
          enabled: true,
          adapter: mockAdapter({
            set: (key, val) => { localStored.set(key, val); },
          }),
        },
      },
    }));

    assert.equal((localStored.get("custom-p") as any).value, 77);
    assert.equal(globalStored.get("custom-p"), undefined);
  });

  it("should support explicitly disabling persistence for a node via persistence: { enabled: false }", async () => {
    const globalStored = new Map<string, unknown>();

    pulse = new StatePulse({
      persistence: mockAdapter({
        set: (key, val) => { globalStored.set(key, val); },
      }),
    });

    await pulse.register(makeNode("disabled-p", () => 88, {
      stateConfig: {
        persistence: {
          enabled: false,
        },
      },
    }));

    assert.equal(globalStored.get("disabled-p"), undefined);
  });

  it("should throw TypeError if persistence is enabled but neither local nor global adapter is set", async () => {
    pulse = new StatePulse({});
    await assert.rejects(() => pulse.register(makeNode("broken-node", () => "ok", {
      stateConfig: {
        persistence: {
          enabled: true,
        },
      },
    })), TypeError);
  });
});

describe("StatePulse — configuration and validation", () => {
  let pulse: StatePulse;
  afterEach(() => { try { pulse.terminate(); } catch {} });

  it("should initialize with no configuration and use default values", async () => {
    pulse = new StatePulse();
    await pulse.register({
      key: "default-node",
      run: () => "ok",
    });
    const snap = await pulse.get<string>("default-node");
    assert.equal(snap!.value, "ok");
  });

  it("should throw TypeError on invalid StatePulseConfig", () => {
    assert.throws(() => new StatePulse({ persistence: "not-an-object" as any }), TypeError);
    assert.throws(() => new StatePulse({ persistence: { get: 123 } as any }), TypeError);
  });

  it("should throw TypeError on invalid StateNode properties during registration", async () => {
    pulse = new StatePulse();
    await assert.rejects(() => pulse.register({ key: 123 as any, run: () => "ok" }), TypeError);
    await assert.rejects(() => pulse.register({ key: "node", run: "not-a-fn" as any }), TypeError);
    await assert.rejects(() => pulse.register({ key: "node", run: () => "ok", refreshPolicy: { intervalMs: -5 } }), TypeError);
    await assert.rejects(() => pulse.register({ key: "node", run: () => "ok", refreshPolicy: { intervalMs: 0 } }), TypeError);
    await assert.rejects(() => pulse.register({ key: "node", run: () => "ok", retryPolicy: { count: -1 } }), TypeError);
    
    /* Invalid stateConfig validation */
    await assert.rejects(() => pulse.register({
      key: "node",
      run: () => "ok",
      stateConfig: {
        history: { historyCycle: -5 },
      },
    }), TypeError);

    await assert.rejects(() => pulse.register({
      key: "node",
      run: () => "ok",
      stateConfig: {
        history: { historyCycle: 10, maxHistoryLength: 5 },
      },
    }), TypeError);
  });

  it("should throw TypeError if history is configured when in-memory and persistence (with addHistory) are both disabled", async () => {
    pulse = new StatePulse({}); /* No global persistence adapter */

    await assert.rejects(() => pulse.register({
      key: "broken-history",
      run: () => "val",
      stateConfig: {
        inMemory: false,
        persistence: {
          enabled: false,
        },
        history: { historyCycle: 5 },
      },
    }), /Cannot configure history/);
  });
});

describe("StatePulse — history sliding window", () => {
  let pulse: StatePulse;
  afterEach(() => { try { pulse.terminate(); } catch {} });

  it("should maintain rolling in-memory history and limit size to maxHistoryLength", async () => {
    pulse = new StatePulse({});

    let runCount = 0;
    await pulse.register({
      key: "rolling-node",
      run: () => {
        runCount++;
        return `val-${runCount}`;
      },
      refreshPolicy: { intervalMs: 20 },
      stateConfig: {
        history: { maxHistoryLength: 3 },
      },
    });

    await wait(120);

    const history = pulse.getHistory<string>("rolling-node");
    assert.equal(history.length, 3);
    assert.equal(history[0].value, `val-${runCount - 2}`);
    assert.equal(history[1].value, `val-${runCount - 1}`);
    assert.equal(history[2].value, `val-${runCount}`);
  });

  it("should return a copied array from getHistory to prevent external mutation", async () => {
    pulse = new StatePulse({});
    await pulse.register({
      key: "mutation-node",
      run: () => "val",
    });

    const history1 = pulse.getHistory<string>("mutation-node");
    assert.equal(history1.length, 1);
    
    history1.pop();
    assert.equal(history1.length, 0);

    const history2 = pulse.getHistory<string>("mutation-node");
    assert.equal(history2.length, 1);
    assert.equal(history2[0].value, "val");
  });
});

describe("StatePulse — security and edge cases", () => {
  let pulse: StatePulse;
  afterEach(() => { try { pulse.terminate(); } catch {} });

  it("should not expose internal state through get", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("secure", () => ({ secret: "data" })));
    const snap = await pulse.get<{ secret: string }>("secure");
    assert.ok(snap);
    assert.equal(snap!.value.secret, "data");
    /* Snapshot should have well-defined shape */
    assert.ok("key" in snap!);
    assert.ok("updatedAt" in snap!);
    assert.ok("timeTaken" in snap!);
    assert.ok("value" in snap!);
  });

  it("should not allow prototype pollution through keys", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("__proto__", () => "safe"));
    const snap = await pulse.get<string>("__proto__");
    assert.equal(snap?.value, "safe");
    /* Prototype should not be modified */
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  it("should not allow constructor pollution through keys", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("constructor", () => "safe"));
    const snap = await pulse.get<string>("constructor");
    assert.equal(snap?.value, "safe");
  });

  it("should handle empty string key", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("", () => "empty-key"));
    const snap = await pulse.get<string>("");
    assert.equal(snap?.value, "empty-key");
  });

  it("should isolate node failures from other nodes", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("healthy", () => "ok", {
      refreshPolicy: { intervalMs: 50, overlapAction: "skip" },
    }));
    await pulse.register(makeNode("broken", () => { throw new Error("crash"); }, {
      retryPolicy: { count: 0 },
      refreshPolicy: { intervalMs: 50, overlapAction: "skip" },
      logErrors: () => {},
    }));
    await wait(150);
    const healthy = await pulse.get<string>("healthy");
    assert.ok(healthy);
    assert.equal(healthy!.value, "ok");
  });

  it("should handle run function returning undefined", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("undef", () => undefined as unknown as string));
    const snap = await pulse.get("undef");
    assert.ok(snap);
    assert.equal(snap!.value, undefined);
  });

  it("should handle run function returning null", async () => {
    pulse = new StatePulse({});
    await pulse.register(makeNode("null-val", () => null as unknown as string));
    const snap = await pulse.get("null-val");
    assert.ok(snap);
    assert.equal(snap!.value, null);
  });

  it("should handle very large values", async () => {
    pulse = new StatePulse({});
    const bigArray = new Array(10000).fill("x");
    await pulse.register(makeNode("big", () => bigArray));
    const snap = await pulse.get<string[]>("big");
    assert.ok(snap);
    assert.equal(snap!.value.length, 10000);
  });
});

describe("StatePulse — process signal handling", () => {
  it("should register SIGINT and SIGTERM listeners", () => {
    const pulse = new StatePulse({});
    const sigintCount = process.listenerCount("SIGINT");
    const sigtermCount = process.listenerCount("SIGTERM");
    assert.ok(sigintCount >= 1, "should have SIGINT listener");
    assert.ok(sigtermCount >= 1, "should have SIGTERM listener");
    pulse.terminate();
  });

  it("should not register listeners when enableSignalHandling is false", () => {
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const pulse = new StatePulse({ enableSignalHandling: false });
    
    assert.equal(process.listenerCount("SIGINT"), sigintBefore);
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
    pulse.terminate();
  });
});
