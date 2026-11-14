import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/bootstrap';
import { type Env, loadEnv } from '../../src/config/env';

export interface TestApp {
  /** Base URL of the instance, on an ephemeral port. */
  readonly url: string;
  /** Every log line the instance wrote, parsed. */
  logs(): Record<string, unknown>[];
  /**
   * A sample of this instance's `GET /metrics`, summed over the series whose labels include
   * `labels`; 0 when no series matches.
   */
  metricValue(name: string, labels?: Record<string, string>): Promise<number>;
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
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    metricValue: async (name, labels = {}) =>
      sample(await (await fetch(`${url}/metrics`)).text(), name, labels),
    logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    close: () => app.close(),
  };
}

/** Sums the samples of `name` in a Prometheus text exposition whose labels include `labels`. */
function sample(text: string, name: string, labels: Record<string, string>): number {
  let total = 0;
  for (const line of text.split('\n')) {
    const match = /^(\w+)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (match?.[1] !== name) continue;
    const series = Object.fromEntries(
      [...(match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
    );
    if (Object.entries(labels).every(([key, value]) => series[key] === value)) {
      total += Number(match[3]);
    }
  }
  return total;
}
