# StatePulse ⚡

StatePulse is a professional-grade background polling and state management engine for Node.js.

Designed for mission-critical services, StatePulse provides periodic execution, automatic retry policies, bounded history buffers, and pluggable persistence adapters.

---

## 🚀 Installation

```bash
npm install statepulse
```

---

## 🛠️ Quick Start

```typescript
import { StatePulse } from "statepulse";

// 1. Initialize StatePulse
const pulse = new StatePulse({
  maxHistoryLength: 50, // Keep rolling history of last 50 execution states in memory
});

// 2. Register a state node
await pulse.register({
  key: "bitcoin-price",
  run: async (signal) => {
    const response = await fetch("https://api.coindesk.com/v1/bpi/currentprice.json", { signal });
    const data = await response.json();
    return parseFloat(data.bpi.USD.rate_float);
  },
  refreshPolicy: {
    intervalMs: 10000,          // Poll every 10 seconds (must be strictly > 0)
    overlapAction: "skip",      // Skip execution if the previous run is still active
  },
  retryPolicy: {
    count: 3,                   // Retry up to 3 times on failure before logging
  },
  logErrors: (err) => console.error(`Failed to fetch BTC price: ${err}`),
});

// 3. Retrieve the latest snapshot (anywhere in your application)
const snapshot = await pulse.get<number>("bitcoin-price");
if (snapshot) {
  console.log(`Latest USD Price: ${snapshot.value}`); // e.g. 68000.5
  console.log(`Last Updated At: ${new Date(snapshot.updatedAt).toISOString()}`);
  console.log(`Fetch Duration: ${snapshot.timeTaken}ms`);
}

// 4. Retrieve execution history safely
const history = pulse.getHistory<number>("bitcoin-price");
console.log(`History records available: ${history.length}`);
```

---

## 📋 API Reference

### `StatePulse`

The main orchestrator class.

#### `new StatePulse(config?: Partial<StatePulseConfig>)`
*   `persistence?: PersistenceAdapter` - Optional persistence adapter.
*   `historyCycle?: number | null` - Optional batch-flushing interval (number of runs before writing history to persistence). Must be `<= maxHistoryLength`.
*   `keepHistoryAfterSave?: boolean` - If `true`, the rolling in-memory history buffer is kept after writing to persistence. Defaults to `false`.
*   `maxHistoryLength?: number` - Maximum size of the rolling in-memory history buffer. Defaults to `100`.
*   `enableSignalHandling?: boolean` - If `true`, automatically registers graceful shutdown listeners on `SIGINT` / `SIGTERM` signals. Defaults to `true` (safely backed by WeakRef GC).

#### `register<T>(node: RegisterNodeConfig<T>): Promise<void>`
Registers and immediately spins up a periodic task loop for a state node. Throws if a key is already registered.

#### `get<T>(key: string): Promise<StateSnapshot<T> | null>`
Retrieves the latest state snapshot for the given key.

#### `getHistory<T>(key: string): StateSnapshot<T>[]`
Returns an immutable clone (defensive array copy) of the rolling history of execution snapshots for the given key.

#### `unregister(key: string): void`
Halts execution for a specific node, clears its memory storage, and removes its history.

#### `terminate(): void`
Gracefully stops all active polling loops, cancels in-flight abort signals, clears all memory stores, and unregisters signal listeners.

#### `activeRuns: string[]`
A getter returning the keys of all nodes that are currently executing their `run` function.

---

## 💾 Custom Persistence Adapter

You can easily plug in any key-value store (like Redis, Keyv, etc.) by implementing the `PersistenceAdapter` interface. TTL is uniformly passed in **milliseconds**.

```typescript
import { StatePulse, PersistenceAdapter } from "statepulse";
import Redis from "ioredis";

const redis = new Redis();

const redisAdapter: PersistenceAdapter = {
  // Retrieve a snapshot
  get: async (key) => {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  },

  // Save the latest state with uniform millisecond TTL
  set: async (key, value, ttlMs) => {
    if (ttlMs) {
      await redis.set(key, JSON.stringify(value), "PX", ttlMs);
    } else {
      await redis.set(key, JSON.stringify(value));
    }
  },

  // (Optional) Bulk insert history cycle batches
  addHistory: async (key, entries) => {
    await redis.lpush(`history:${key}`, ...entries.map(e => JSON.stringify(e)));
  }
};

const pulse = new StatePulse({
  persistence: redisAdapter,
  historyCycle: 10,
  maxHistoryLength: 50,
});
```

---

## ⚡ Scheduling & Overlap Actions

StatePulse offers two standard policies when a task's execution takes longer than its polling interval:

1.  **`skip` (Default)**: If a polling task is still running when the next cycle is scheduled to start, StatePulse will skip the missed cycle. The next cycle will schedule at `nextExpectedTick + interval`.
2.  **`overlap`**: The subsequent polling cycle starts immediately at its scheduled time, running concurrently with the in-flight task.

---

## 📄 License

MIT © Leo
