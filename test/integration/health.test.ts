import { afterEach, describe, expect, test } from 'bun:test';
import type { TCPSocketListener } from 'bun';
import { startApp, type TestApp } from '../support/app';

// Nothing listens on port 1: connections are refused at once.
const REFUSED_DATABASE_URL = 'postgresql://wagering:wagering@127.0.0.1:1/wagering_test';
const REFUSED_ENDPOINT = 'http://127.0.0.1:1';

let app: TestApp | undefined;
let blackHole: TCPSocketListener | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  blackHole?.stop(true);
  blackHole = undefined;
});

describe('GET /health/live', () => {
  test('is 200 without touching dependencies', async () => {
    app = await startApp({
      DATABASE_URL: REFUSED_DATABASE_URL,
      AWS_ENDPOINT_URL: REFUSED_ENDPOINT,
    });

    const response = await fetch(`${app.url}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  test('is 200 with PostgreSQL and SQS up', async () => {
    app = await startApp();

    const response = await fetch(`${app.url}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'up', sqs: 'up' },
    });
  });

  test('is 503 and names sqs when SQS is unreachable', async () => {
    app = await startApp({ AWS_ENDPOINT_URL: REFUSED_ENDPOINT });

    const response = await fetch(`${app.url}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: 'up', sqs: 'down' },
    });
  });

  test('is 503 and names sqs when the transactions queue does not exist', async () => {
    app = await startApp({ WAGER_TRANSACTIONS_QUEUE_NAME: 'no-such-queue.fifo' });

    const response = await fetch(`${app.url}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: 'up', sqs: 'down' },
    });
  });

  test('is 503 and names postgres when PostgreSQL is unreachable', async () => {
    app = await startApp({ DATABASE_URL: REFUSED_DATABASE_URL });

    const response = await fetch(`${app.url}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: 'down', sqs: 'up' },
    });
  });

  test('logs the failing dependency without exposing the cause in the response', async () => {
    app = await startApp({ AWS_ENDPOINT_URL: REFUSED_ENDPOINT });

    const response = await fetch(`${app.url}/health/ready`);
    const body = await response.text();

    const warning = app.logs().find((line) => line.message === 'readiness check failed');
    expect(warning).toMatchObject({ level: 'warn', dependency: 'sqs' });
    expect(warning?.errorMessage).toBeString();
    expect(body).not.toContain('127.0.0.1');
  });

  test('answers 503 within the timeout when both dependencies hang', async () => {
    // Accepts connections and never answers, like a dependency that stopped responding.
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    blackHole = listener;
    app = await startApp({
      DATABASE_URL: `postgresql://wagering:wagering@127.0.0.1:${listener.port}/wagering_test`,
      AWS_ENDPOINT_URL: `http://127.0.0.1:${listener.port}`,
      READINESS_TIMEOUT_MS: 300,
      // Without a connect timeout the abandoned attempt would also block the shutdown below.
      DATABASE_CONNECT_TIMEOUT_MS: 300,
    });

    const startedAt = performance.now();
    const response = await fetch(`${app.url}/health/ready`);
    const elapsedMs = performance.now() - startedAt;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: 'down', sqs: 'down' },
    });
    expect(elapsedMs).toBeLessThan(1500);
  });
});
