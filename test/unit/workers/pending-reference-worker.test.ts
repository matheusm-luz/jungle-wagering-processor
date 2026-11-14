import { describe, expect, test } from 'bun:test';
import type { DuePending } from '../../../src/application/ports';
import type { ResolvePendingReferences } from '../../../src/application/resolve-pending-references';
import { loadEnv } from '../../../src/config/env';
import { JsonLogger } from '../../../src/infrastructure/logging/json-logger';
import { Metrics } from '../../../src/infrastructure/metrics/metrics';
import { PendingReferenceWorker } from '../../../src/infrastructure/workers/pending-reference.worker';

const env = loadEnv({
  DATABASE_URL: 'postgresql://wagering:wagering@localhost:5432/wagering',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '30',
  PENDING_REFERENCE_BATCH_SIZE: '2',
});

const rows: DuePending[] = [
  { id: 'tx-1', walletId: 'wallet-1', providerId: 'provider-a', correlationId: 'corr-1' },
  { id: 'tx-2', walletId: 'wallet-2', providerId: 'provider-a', correlationId: undefined },
];

/** A resolver whose every retry throws `error`, as a row that always fails would. */
function failingResolver(
  error: Error = new Error('poison row'),
  outcome: 'postponed' | 'FAILED' = 'postponed',
) {
  const calls = { findDue: 0, postponed: [] as string[], counted: [] as boolean[] };
  const resolver = {
    findDue: async () => {
      calls.findDue++;
      return rows;
    },
    retry: async () => {
      throw error;
    },
    postpone: async ({ id }: DuePending, options?: { countsAttempt?: boolean }) => {
      calls.postponed.push(id);
      calls.counted.push(options?.countsAttempt === true);
      return outcome;
    },
  };
  return { resolver: resolver as unknown as ResolvePendingReferences, calls };
}

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger({
    level: 'debug',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('PendingReferenceWorker (S7 review)', () => {
  test('a full batch of rows that always fail is postponed and does not make the worker poll again at once (M1)', async () => {
    const { resolver, calls } = failingResolver();
    const { logger, lines } = capturingLogger();
    const worker = new PendingReferenceWorker(resolver, env, logger, new Metrics());

    worker.onApplicationBootstrap();
    await Bun.sleep(200);
    await worker.beforeApplicationShutdown();

    // One poll per 30 ms interval at most; a 0 ms loop would make thousands.
    expect(calls.findDue).toBeGreaterThan(0);
    expect(calls.findDue).toBeLessThan(10);
    expect(calls.postponed.length).toBe(calls.findDue * rows.length);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'pending reference retry failed',
        errorName: 'Error',
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        providerId: 'provider-a',
        correlationId: 'corr-1',
      }),
    );
    // Only the error's name: a driver message can carry row data.
    expect(JSON.stringify(lines)).not.toContain('poison row');
  });

  test('a non-transient error counts an attempt; a transient database error does not (S12 Q2)', async () => {
    for (const [error, counted] of [
      [new Error('poison row'), true],
      [
        Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
        false,
      ],
      [new Error('Connection terminated unexpectedly'), false],
    ] as const) {
      const { resolver, calls } = failingResolver(error);
      const worker = new PendingReferenceWorker(
        resolver,
        env,
        capturingLogger().logger,
        new Metrics(),
      );

      worker.onApplicationBootstrap();
      await Bun.sleep(60);
      await worker.beforeApplicationShutdown();

      expect(calls.counted.length).toBeGreaterThan(0);
      expect({ error: error.message, counted: calls.counted.every((c) => c === counted) }).toEqual({
        error: error.message,
        counted: true,
      });
    }
  });

  test('a row the postpone turns FAILED is counted on the worker channel and logged (S12 Q2)', async () => {
    const { resolver } = failingResolver(new Error('poison row'), 'FAILED');
    const { logger, lines } = capturingLogger();
    const metrics = new Metrics();
    const worker = new PendingReferenceWorker(resolver, env, logger, metrics);

    worker.onApplicationBootstrap();
    await Bun.sleep(60);
    await worker.beforeApplicationShutdown();

    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'pending reference failed',
        transactionId: 'tx-1',
      }),
    );
    expect(await metrics.registry.getSingleMetricAsString('wager_transactions_total')).toContain(
      'channel="worker",status="FAILED"',
    );
  });

  test('a poll that rejects is logged and the worker keeps polling (m4)', async () => {
    const { resolver, calls } = failingResolver();
    const lines: Record<string, unknown>[] = [];
    // Error lines cannot be written: the per-row catch itself throws, so the poll rejects.
    const logger = new JsonLogger({
      level: 'debug',
      write: (line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.level === 'error') throw new Error('log sink down');
        lines.push(record);
      },
    });
    const worker = new PendingReferenceWorker(resolver, env, logger, new Metrics());

    worker.onApplicationBootstrap();
    await Bun.sleep(150);
    await worker.beforeApplicationShutdown();

    expect(calls.findDue).toBeGreaterThan(1);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'pending reference poll failed' }),
    );
  });
});
