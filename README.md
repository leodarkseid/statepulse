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

// 1. Initialize StatePulse (no global limits or cycles needed here)
const pulse = new StatePulse();

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
  stateConfig: {
    inMemory: true,             // Cache last successful run in-memory (defaults to true)
    history: {
      maxHistoryLength: 50,     // Limit rolling history queue length to prevent OOM (defaults to 100)
    },
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

## 📌 Usage Guidance

Create **one** `StatePulse` instance and register all your polling tasks on it using `.register()`. Each registered node runs its own independent loop with its own interval, retry policy, and history buffer.

**Do not** create a new `StatePulse` instance per task — it offers no advantage and wastes resources (each instance spins up its own signal handlers, state manager, and internal maps).

```typescript
// ✅ Correct — single instance, multiple nodes
const pulse = new StatePulse();
await pulse.register({ key: "exchange-rate", run: fetchExchangeRates, refreshPolicy: { intervalMs: 10000 } });
await pulse.register({ key: "db-health", run: pingDatabase, refreshPolicy: { intervalMs: 60000 } });

// ❌ Wrong — wasteful, no benefit
const pricePulse = new StatePulse();
const healthPulse = new StatePulse();
```

---

## 📋 API Reference

### `StatePulse`

The main orchestrator class.

#### `new StatePulse(config?: Partial<StatePulseConfig>)`
*   `persistence?: PersistenceAdapter | null` - Optional global persistence adapter to fall back on if a node doesn't define its own. Pass `null` to explicitly disable fallback.
*   `enableSignalHandling?: boolean` - If `true`, automatically registers graceful shutdown listeners on `SIGINT` / `SIGTERM` signals. Defaults to `true` (safely backed by WeakRef GC).

#### `register<T>(node: RegisterNodeConfig<T>): Promise<void>`
Registers and immediately spins up a periodic task loop for a state node. Throws if a key is already registered or if invalid configuration options are provided.

##### `RegisterNodeConfig<T>` properties:
*   `key: string` - Unique identifier key for the state node.
*   `run: (signal: AbortSignal) => T | Promise<T>` - Polling function. Receives an AbortSignal to gracefully cancel in-flight executions.
*   `logErrors?: boolean | ((error: string) => void)` - Error logging mode. Can be a boolean (stderr logging) or a custom callback. Defaults to `false`.
*   `refreshPolicy?: { intervalMs?: number, overlapAction?: 'skip' | 'overlap' }`
    *   `intervalMs` - Interval duration between polls. Defaults to `300000` (5 minutes).
    *   `overlapAction` - Cadence when run duration exceeds interval. `"skip"` (default) to drop missed cycles, `"overlap"` to execute concurrently.
*   `retryPolicy?: { count?: number }`
    *   `count` - Maximum retries on execution failure before logging. Defaults to `3`.
*   `stateConfig?: NodeStateConfig` - Nested state block controlling storage:
    *   `inMemory?: boolean` - Whether to cache successful runs in the local in-memory store. Defaults to `true`.
    *   `persistence?: NodePersistenceConfig` - Node-specific persistence configuration block:
        *   `enabled?: boolean` - Whether to enable persistence for this node. If `true`, requires either a node-specific adapter to be defined or a global persistence adapter to be set. If `false`, explicitly disables persistence for this node. If omitted, defaults to `true` if a node-specific `adapter` is defined, otherwise defaults to the presence of a global persistence adapter.
        *   `adapter?: PersistenceAdapter | null` - Optional node-specific persistence adapter to override the global one.
    *   `history?: { historyCycle?: number | null, keepHistoryAfterSave?: boolean, maxHistoryLength?: number }` - Queue constraints:
        *   `historyCycle?: number | null` - Number of execution cycles before flushing history entries in bulk to the persistence adapter. If `null` (default), history is kept in memory. If a cycle is configured but the active adapter does not implement `addHistory`, it gracefully falls back to keeping the history in-memory only.
        *   `keepHistoryAfterSave?: boolean` - Whether to retain history in the local memory queue after flushing to persistence. Defaults to `false`.
        *   `maxHistoryLength?: number` - Strict upper bound of history snapshots stored in memory. Defaults to `100`.

##### ⚠️ Safety Validation:
* If `persistence.enabled` is explicitly set to `true`, but neither a node-specific adapter nor a global persistence adapter is configured, registration will throw a `TypeError`.
* If `stateConfig.history` is configured, but `inMemory` is explicitly disabled (`false`), **and** no active persistence adapter with `addHistory` is available (either because persistence is disabled or the adapter does not implement `addHistory`), the `register` call will immediately throw a `TypeError` to prevent silent history data loss.

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
  persistence: redisAdapter, // Set as global fallback persistence adapter
});

await pulse.register({
  key: "exchange-rate",
  run: fetchRates,
  stateConfig: {
    history: {
      historyCycle: 10,       // Flush history queue to redis every 10 cycles
      maxHistoryLength: 50,   // Bound local queue to 50 snapshots
    },
  },
});
```
---

## ⚡ Scheduling & Overlap Actions

StatePulse offers two standard policies when a task's execution takes longer than its polling interval:

1.  **`skip` (Default)**: If a polling task is still running when the next cycle is scheduled to start, StatePulse will skip the missed cycle. The next cycle will schedule at `nextExpectedTick + interval`.
2.  **`overlap`**: The subsequent polling cycle starts immediately at its scheduled time, running concurrently with the in-flight task.

---

## 🔌 Framework Integration

### NestJS

Use the official [`@statepulse/nestjs`](./packages/nestjs) module for full dependency injection and lifecycle management:

```bash
npm install statepulse @statepulse/nestjs
```

```typescript
import { Module } from "@nestjs/common";
import { StatePulseModule } from "@statepulse/nestjs";

@Module({
  imports: [StatePulseModule.forRoot()],
})
export class AppModule {}
```

Then inject `StatePulseService` into any provider. See the [full documentation](./packages/nestjs/README.md).

### Fastify

Decorate the Fastify instance and hook into `onClose` for graceful shutdown:

```typescript
import Fastify from "fastify";
import { StatePulse } from "statepulse";

const fastify = Fastify();
const pulse = new StatePulse();

fastify.decorate("pulse", pulse);
fastify.addHook("onClose", () => { pulse.terminate(); });

await pulse.register({
  key: "db-health",
  run: async () => { /* ... */ },
  refreshPolicy: { intervalMs: 30000 },
});

fastify.get("/health", async () => {
  return await pulse.get("db-health");
});
```

### Express

No wrapper needed — instantiate and use directly:

```typescript
import express from "express";
import { StatePulse } from "statepulse";

const app = express();
const pulse = new StatePulse();

await pulse.register({
  key: "exchange-rates",
  run: async () => { /* ... */ },
  refreshPolicy: { intervalMs: 15000 },
});

app.get("/rates", async (_req, res) => {
  const snapshot = await pulse.get("exchange-rates");
  res.json(snapshot);
});

process.on("SIGTERM", () => {
  pulse.terminate();
  process.exit(0);
});
```

---

## 📄 License

MIT © Leo
