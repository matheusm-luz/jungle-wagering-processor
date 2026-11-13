import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/bootstrap';
import { type Env, loadEnv } from '../../src/config/env';
import { Metrics } from '../../src/infrastructure/metrics/metrics';

export interface TestApp {
  /** Base URL of the instance, on an ephemeral port. */
  readonly url: string;
  /** Every log line the instance wrote, parsed. */
  logs(): Record<string, unknown>[];
  /** Current value of an in-process counter of this instance. */
  metricValue(name: string): number;
  close(): Promise<void>;
}

/**
 * Boots the real application, through the same `createApp` as `main.ts`, against the PostgreSQL
 * and LocalStack containers of the suite. `overrides` replaces single environment values; pass a
 * `PENDING_REFERENCE_POLL_INTERVAL_MS` to run the pending-reference worker.
 */
export async function startApp(overrides: Partial<Env> = {}): Promise<TestApp> {
  const lines: string[] = [];
  const env: Env = {
    ...loadEnv(process.env),
    LOG_LEVEL: 'debug',
    // The pending-reference worker idles unless a test turns it on: the suite database is shared,
    // and a worker retrying rows of other suites would make timings depend on them (S7 review, m6).
    PENDING_REFERENCE_POLL_INTERVAL_MS: 1_000_000_000,
    ...overrides,
  };
  const app = await createApp(env, { writeLog: (line) => lines.push(line) });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    metricValue: (name) => app.get(Metrics).value(name),
    logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    close: () => app.close(),
  };
}
