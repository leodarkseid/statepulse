<div align="center">
  <h1>StatePulse ⚡</h1>
  <p><strong>Run any async task on a heartbeat. Capture every result. Never miss a pulse.</strong></p>
  <p><i>From polling remote APIs to calculating live metrics, syncing edge state to reading sensor data — StatePulse orchestrates it all with surgical precision.</i></p>
</div>

---

StatePulse is a zero-dependency periodic execution and state management engine. Define a task. Give it an interval. StatePulse takes care of everything else, retrying on failure, caching the result, respecting overlap boundaries, persisting history, and tearing down cleanly when the process exits.

Run it in a Node.js server, a Deno edge function, a frontend, a browser worker, or an embedded runtime. StatePulse doesn't care where it runs — it just runs, reliably.

## ✨ Why StatePulse?

There is no other library that combines background execution control, automatic state retention, and pluggable persistence into one coherent, dependency-free primitive.

- ⚡ **Absolute Execution Control**: Stop wrestling with `setInterval` drifts. Define exact polling intervals, robust retry limits, and smart overlap boundaries (skip vs. concurrent).
- 🪶 **Featherweight & Zero-Dependency**: No bloat, no conflicts. A minuscule footprint that's equally at home in a heavily constrained IoT device as it is in a massive cloud fleet.
- 💾 **State That Survives**: Instantly plug in Redis, Postgres, or any key-value store to persist state across process restarts—or keep it strictly lightning-fast in-memory.
- 🛡️ **Bulletproof Memory Management**: Built for services that never sleep. Bounded history buffers and automatic eviction mean zero memory leaks and no OOM crashes.
- 🛑 **Graceful By Default**: Native `AbortSignal` propagation ensures cleanly aborted network requests and safe teardowns the moment an exit signal is fired.
- 🔌 **Run It Anywhere**: Drop it into NestJS, Fastify,NextJs, React,  Express, or use it raw. Node.js, Deno, Bun, or the browser, it just works.

---

## 🚀 Installation

```bash
npm install statepulse
```

---

## 🛠️ Quick Start

Manage periodic state execution and background data polling with absolute reliability.

```typescript
import { StatePulse } from "statepulse";

// 1. Initialize StatePulse (Zero global config needed by default)
const pulse = new StatePulse();

// 2. Register a declarative state node
await pulse.register({
  key: "bitcoin-price",
  run: async (signal) => {
    // AbortSignal is automatically provided for graceful cancellations!
    const response = await fetch("https://api.coindesk.com/v1/bpi/currentprice.json", { signal });
    const data = await response.json();
    return parseFloat(data.bpi.USD.rate_float);
  },
  refreshPolicy: {
    intervalMs: 10000,          // Poll every 10 seconds 
    overlapAction: "skip",      // Skip execution if the previous run is still active
  },
  retryPolicy: {
    count: 3,                   // Automatically retry up to 3 times on failure
  },
  stateConfig: {
    inMemory: true,             // Cache the last successful run in-memory
    history: {
      maxHistoryLength: 50,     // Bounded rolling history to prevent memory leaks
    },
  },
  logErrors: (err) => console.error(`Failed to fetch BTC price: ${err}`),
});

// 3. Instantly retrieve the latest snapshot (zero blocking!)
const snapshot = await pulse.get<number>("bitcoin-price");
if (snapshot) {
  console.log(`Latest USD Price: $${snapshot.value}`);
  console.log(`Last Updated At: ${new Date(snapshot.updatedAt).toISOString()}`);
  console.log(`Fetch Duration: ${snapshot.timeTaken}ms`);
}

// 4. Retrieve execution history safely
const history = pulse.getHistory<number>("bitcoin-price");
console.log(`History records available: ${history.length}`);
```

---

## 📌 Usage Guidance: The Single Instance Pattern

Create **one** `StatePulse` instance and register all your polling tasks on it using `.register()`. Each registered node runs its own independent background loop with its own interval, retry policy, and history buffer.

**Do not** create a new `StatePulse` instance per task — the centralized orchestrator is highly optimized to handle hundreds of nodes simultaneously without wasting resources.

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

## 💾 Custom Persistence Adapters

StatePulse scales from a single Node.js process to a distributed microservice fleet. Easily plug in any key-value store (Redis, Keyv, etc.) by implementing the `PersistenceAdapter` interface.

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
      historyCycle: 10,       // Automatically flush history queue to redis every 10 cycles!
      maxHistoryLength: 50,   // Bound local queue to 50 snapshots
    },
  },
});
```

---

## ⚡ Scheduling & Overlap Actions

What happens when your backend fetch takes longer than its polling interval? StatePulse provides intelligent overflow handling out of the box:

1.  **`skip` (Default)**: If a task is still running when the next cycle is scheduled to start, StatePulse safely skips the missed cycle. The next cycle will schedule precisely at `nextExpectedTick + interval`.
2.  **`overlap`**: The subsequent polling cycle starts immediately at its scheduled time, running concurrently with the in-flight task for maximum throughput.

---

## 🔌 Framework Integration

StatePulse is unopinionated and works anywhere.

### NestJS

Use the official [`@statepulse/nestjs`](./packages/nestjs) module for robust dependency injection and lifecycle management:

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

### Fastify

Decorate your instance and automatically hook into `onClose` for graceful zero-downtime shutdown:

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

Just instantiate and use directly:

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

// Safe cleanup on exit
process.on("SIGTERM", () => {
  pulse.terminate();
  process.exit(0);
});
```

---

## 📋 API Reference

### `StatePulse`

The main orchestrator class.

#### `new StatePulse(config?: Partial<StatePulseConfig>)`
*   `persistence?: PersistenceAdapter | null` - Optional global persistence adapter.
*   `enableSignalHandling?: boolean` - If `true`, automatically gracefully aborts tasks on `SIGINT` / `SIGTERM`. Defaults to `true`.

#### `register<T>(node: RegisterNodeConfig<T>): Promise<void>`
Registers and instantly spins up a periodic task loop.

##### `RegisterNodeConfig<T>`
*   `key: string` - Unique identifier for the task.
*   `run: (signal: AbortSignal) => T | Promise<T>` - Polling function.
*   `logErrors?: boolean | ((error: string) => void)` - Defaults to `false`.
*   `refreshPolicy`
    *   `intervalMs` - Interval duration between polls. Defaults to `300000` (5 minutes).
    *   `overlapAction` - `"skip"` (default) or `"overlap"`.
*   `retryPolicy`
    *   `count` - Maximum retries on execution failure. Defaults to `3`.
*   `stateConfig`
    *   `inMemory?: boolean` - Cache locally? Defaults to `true`.
    *   `persistence?: NodePersistenceConfig` - Enable/disable or override persistence for this specific node.
    *   `history?: { historyCycle?: number, keepHistoryAfterSave?: boolean, maxHistoryLength?: number }` - Tune exactly how history is buffered and flushed.

#### `get<T>(key: string): Promise<StateSnapshot<T> | null>`
Instantly retrieves the latest state snapshot for the given key without blocking.

#### `getHistory<T>(key: string): StateSnapshot<T>[]`
Returns an immutable clone of the rolling history of execution snapshots.

#### `unregister(key: string): void`
Halts execution for a specific node, and clears its memory storage and history.

#### `terminate(): void`
Gracefully stops all active polling loops, cancels in-flight requests, and clears memory stores.

#### `activeRuns: string[]`
A getter returning the keys of all nodes currently executing.

---

## 📄 License

MIT © Leo
