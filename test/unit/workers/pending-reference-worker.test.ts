import { describe, expect, test } from 'bun:test';
import type { DuePending } from '../../../src/application/ports';
import type { ResolvePendingReferences } from '../../../src/application/resolve-pending-references';
import { loadEnv } from '../../../src/config/env';
import { JsonLogger } from '../../../src/infrastructure/logging/json-logger';
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

/** A resolver whose every retry throws, as a row that always fails would. */
function failingResolver() {
  const calls = { findDue: 0, postponed: [] as string[] };
  const resolver = {
    findDue: async () => {
      calls.findDue++;
      return rows;
    },
    retry: async () => {
      throw new Error('poison row');
    },
    postpone: async ({ id }: DuePending) => {
      calls.postponed.push(id);
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
    const worker = new PendingReferenceWorker(resolver, env, logger);

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
    const worker = new PendingReferenceWorker(resolver, env, logger);

    worker.onApplicationBootstrap();
    await Bun.sleep(150);
    await worker.beforeApplicationShutdown();

    expect(calls.findDue).toBeGreaterThan(1);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'pending reference poll failed' }),
    );
  });
});
