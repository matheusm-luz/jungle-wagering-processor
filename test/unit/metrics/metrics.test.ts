import { describe, expect, test } from 'bun:test';
import { Metrics } from '../../../src/infrastructure/metrics/metrics';

/** Statement §12: the seven required metrics, plus the S8 and S9 counters. */
const FAMILIES: Record<string, string> = {
  wager_transactions_total: 'counter',
  wager_transaction_processing_seconds: 'histogram',
  wager_duplicates_total: 'counter',
  retries_total: 'counter',
  sqs_dead_lettered_total: 'counter',
  sqs_unknown_wallet_messages_total: 'counter',
  lock_conflicts_total: 'counter',
  wallet_lock_wait_seconds: 'histogram',
  wallet_reconciliation_divergences_total: 'counter',
};

describe('Metrics (R-61)', () => {
  test('every family is rendered with HELP and TYPE before its first event', async () => {
    const text = await new Metrics().registry.metrics();

    for (const [name, type] of Object.entries(FAMILIES)) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} ${type}\n`);
    }
  });

  test('two instances never share a value', async () => {
    const first = new Metrics();
    const second = new Metrics();

    first.transactions.inc({ channel: 'http', status: 'PROCESSED' });
    first.processing.observe({ channel: 'http' }, 0.02);

    expect(await first.registry.metrics()).toContain(
      'wager_transactions_total{channel="http",status="PROCESSED"} 1',
    );
    expect(await first.registry.metrics()).toContain(
      'wager_transaction_processing_seconds_count{channel="http"} 1',
    );
    expect(await second.registry.metrics()).not.toContain('channel="http"');
  });
});
