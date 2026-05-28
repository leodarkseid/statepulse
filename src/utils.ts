/**
 * Executes a function (sync or async) and measures its execution duration in milliseconds.
 * Captures thrown errors safely, returning a structured outcome object.
 */
export async function runAndTime<T>(
  run: () => T | Promise<T>,
): Promise<
  | { ok: true; result: T; time: number }
  | { ok: false; result: undefined; time: number; error: unknown }
> {
  const startTime = performance.now();

  try {
    const result = await run();
    const time = performance.now() - startTime;

    return {
      ok: true,
      result,
      time,
    };
  } catch (error) {
    const time = performance.now() - startTime;

    return {
      ok: false,
      result: undefined,
      time,
      error,
    };
  }
}
