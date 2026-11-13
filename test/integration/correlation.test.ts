import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startApp, type TestApp } from '../support/app';
import { eventually } from '../support/eventually';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let app: TestApp;

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  await app.close();
});

const requestLog = (correlationId: string) =>
  eventually(() =>
    app
      .logs()
      .find((line) => line.message === 'http request' && line.correlationId === correlationId),
  );

describe('correlation id', () => {
  test('echoes X-Correlation-Id and stamps it on the request log line', async () => {
    const response = await fetch(`${app.url}/health/ready?token=not-logged`, {
      headers: { 'X-Correlation-Id': 'provider-7:req_42.a' },
    });

    expect(response.headers.get('x-correlation-id')).toBe('provider-7:req_42.a');
    expect(response.headers.has('x-powered-by')).toBe(false);
    const line = await requestLog('provider-7:req_42.a');
    expect(line).toMatchObject({ method: 'GET', path: '/health/ready', status: 200 });
    expect(line.durationMs).toBeNumber();
    expect(JSON.stringify(line)).not.toContain('not-logged');
  });

  test('generates an id when the header is missing', async () => {
    const response = await fetch(`${app.url}/no-such-route`);

    const correlationId = response.headers.get('x-correlation-id') ?? '';
    expect(correlationId).toMatch(UUID_V7);
    expect(await requestLog(correlationId)).toMatchObject({
      level: 'info',
      path: '/no-such-route',
      status: 404,
    });
  });

  test('gives concurrent requests distinct ids', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => fetch(`${app.url}/health/live`)),
    );

    const ids = new Set(responses.map((response) => response.headers.get('x-correlation-id')));
    expect(ids.size).toBe(20);
  });

  test('replaces an unsafe header value', async () => {
    for (const unsafe of ['has spaces', '"quoted"', 'x'.repeat(129)]) {
      const response = await fetch(`${app.url}/health/live`, {
        headers: { 'X-Correlation-Id': unsafe },
      });

      expect(response.headers.get('x-correlation-id')).toMatch(UUID_V7);
    }
  });
});
