/** Polls `read` until it returns a value, for effects that land just after an HTTP response. */
export async function eventually<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (performance.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs} ms`);
    }
    await Bun.sleep(10);
  }
}
