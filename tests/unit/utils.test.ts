import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAndTime } from "../../src/utils.js";

describe("runAndTime", () => {
  it("should return ok: true with result for sync functions", async () => {
    const result = await runAndTime(() => 42);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.result, 42);
      assert.equal(typeof result.time, "number");
      assert.ok(result.time >= 0);
    }
  });

  it("should return ok: true with result for async functions", async () => {
    const result = await runAndTime(async () => "hello");

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.result, "hello");
    }
  });

  it("should return ok: false with error for throwing sync functions", async () => {
    const result = await runAndTime(() => {
      throw new Error("boom");
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.result, undefined);
      assert.ok(result.error instanceof Error);
      assert.equal((result.error as Error).message, "boom");
      assert.equal(typeof result.time, "number");
    }
  });

  it("should return ok: false with error for rejecting async functions", async () => {
    const result = await runAndTime(async () => {
      throw new Error("async boom");
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error instanceof Error);
      assert.equal((result.error as Error).message, "async boom");
    }
  });

  it("should measure time accurately", async () => {
    const result = await runAndTime(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "done";
    });

    assert.equal(result.ok, true);
    assert.ok(result.time >= 40, `Expected time >= 40ms, got ${result.time}`);
  });
});
