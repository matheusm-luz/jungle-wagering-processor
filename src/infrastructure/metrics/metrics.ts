import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry } from 'prom-client';

/**
 * The metrics of one instance (statement §12, R-61), served by `GET /metrics`; a scraper sums the
 * counters of the instances. Each instance owns its registry, never prom-client's global one:
 * the tests boot several applications in one process. The gauges read at scrape time are added
 * by `BacklogGauges`.
 */
@Injectable()
export class Metrics {
  readonly registry = new Registry();

  /** One per status a transaction reaches: a reversal that waited counts its PENDING_REFERENCE too. */
  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions by the status they reached; replays and duplicates are not counted',
    labelNames: ['channel', 'status'] as const,
    registers: [this.registry],
  });

  readonly processing = new Histogram({
    name: 'wager_transaction_processing_seconds',
    help: 'Time to process one wager transaction request or message, errors included',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Idempotent replays over HTTP and SQS, and SQS messages already in the inbox',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'retries_total',
    help: 'Retries scheduled: an SQS message made visible again, an outbox event rescheduled, a pending reference rescheduled',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  readonly deadLettered = new Counter({
    name: 'sqs_dead_lettered_total',
    help: 'Messages this instance moved to the DLQ itself; the redrive policy moves are in sqs_dlq_messages',
    registers: [this.registry],
  });

  readonly unknownWallet = new Counter({
    name: 'sqs_unknown_wallet_messages_total',
    help: 'SQS messages acknowledged for a wallet that does not exist (L-08)',
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Transactions that waited longer than DATABASE_LOCK_TIMEOUT_MS for a lock (55P03)',
    registers: [this.registry],
  });

  readonly lockWait = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Time spent acquiring a wallet lock, timeouts included',
    registers: [this.registry],
  });

  readonly reconciliationDivergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliations that found a stored balance different from the ledger',
    registers: [this.registry],
  });
}
