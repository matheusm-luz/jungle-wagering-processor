import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/bootstrap';
import { type Env, loadEnv } from '../../src/config/env';

export interface TestApp {
  /** Base URL of the instance, on an ephemeral port. */
  readonly url: string;
  /** Every log line the instance wrote, parsed. */
  logs(): Record<string, unknown>[];
  close(): Promise<void>;
}

/**
 * Boots the real application, through the same `createApp` as `main.ts`, against the PostgreSQL
 * and LocalStack containers of the suite. `overrides` replaces single environment values.
 */
export async function startApp(overrides: Partial<Env> = {}): Promise<TestApp> {
  const lines: string[] = [];
  const env: Env = { ...loadEnv(process.env), LOG_LEVEL: 'debug', ...overrides };
  const app = await createApp(env, { writeLog: (line) => lines.push(line) });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    close: () => app.close(),
  };
}
