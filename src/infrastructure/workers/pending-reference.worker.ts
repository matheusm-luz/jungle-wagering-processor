import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { DuePending } from '../../application/ports';
import { ResolvePendingReferences } from '../../application/resolve-pending-references';
import type { Env } from '../../config/env';
import { ENV } from '../../config/env.token';
import { JsonLogger } from '../logging/json-logger';
import { type LogContext, runWithLogContext } from '../logging/log-context';
import { Metrics } from '../metrics/metrics';
import { isTransientDatabaseError } from '../persistence/transient-errors';

/**
 * Runs `ResolvePendingReferences` in every instance (ADR-05): one poll per interval, or at once
 * after a full batch that made progress, so a backlog drains. Rows are retried one at a time, each
 * in its own transaction. On shutdown it starts nothing new and waits for the retry in flight,
 * which ends in a commit or a rollback either way: nothing is half done.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly resolver: ResolvePendingReferences,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: JsonLogger,
    private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(this.env.PENDING_REFERENCE_POLL_INTERVAL_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    this.logger.info('pending reference worker stopped');
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.poll()
        .catch((error: unknown) => {
          // Not `error`: a sink that refuses error lines is one way to get here (S7 review, m4).
          this.logger.warn('pending reference poll failed', { errorName: errorName(error) });
          return false;
        })
        .then((more) => {
          this.running = undefined;
          this.schedule(more ? 0 : this.env.PENDING_REFERENCE_POLL_INTERVAL_MS);
        });
    }, delayMs);
  }

  /** One batch. True when the batch was full and some retry completed, so more rows may be due. */
  private async poll(): Promise<boolean> {
    const limit = this.env.PENDING_REFERENCE_BATCH_SIZE;
    let due: DuePending[];
    try {
      due = await this.resolver.findDue(limit);
    } catch (error) {
      // Only the error's name: a driver message can carry row data (S3 review, m2).
      this.logger.warn('pending reference scan failed', { errorName: errorName(error) });
      return false;
    }

    this.logger.debug('pending reference poll', { due: due.length });
    // Every instance reads the same head of the queue; a shuffled order spreads them over
    // different wallets instead of queueing all of them on one lock (S7 review, m3).
    shuffle(due);
    let progressed = false;
    for (const row of due) {
      if (this.stopped) return false;
      await runWithLogContext(logContextOf(row), async () => {
        try {
          const outcome = await this.resolver.retry(row);
          progressed = true;
          if (outcome === 'rescheduled') {
            this.metrics.retries.inc({ source: 'pending_reference' });
          } else if (outcome !== 'skipped') {
            this.metrics.transactions.inc({ channel: 'worker', status: outcome });
          }
          if (outcome !== 'skipped') this.logger.info('pending reference retried', { outcome });
        } catch (error) {
          this.logger.error('pending reference retry failed', { errorName: errorName(error) });
          await this.postpone(row, !isTransientDatabaseError(error));
        }
      });
    }
    return due.length === limit && progressed;
  }

  /**
   * Moves a row that failed out of the head of the queue (S7 review, M1). A non-transient failure
   * counts an attempt, and the last one makes the row FAILED (docs/tasks/S12.md, Q2).
   */
  private async postpone(row: DuePending, countsAttempt: boolean): Promise<void> {
    try {
      const outcome = await this.resolver.postpone(row, { countsAttempt });
      if (outcome === 'FAILED') {
        this.metrics.transactions.inc({ channel: 'worker', status: outcome });
        this.logger.error('pending reference failed', { failureCode: 'PROCESSING_FAILED' });
      }
    } catch (error) {
      this.logger.warn('pending reference postpone failed', { errorName: errorName(error) });
    }
  }
}

function logContextOf({ id, walletId, providerId, correlationId }: DuePending): LogContext {
  const context: LogContext = { transactionId: id, walletId, providerId };
  if (correlationId !== undefined) context.correlationId = correlationId;
  return context;
}

/** Fisher–Yates, in place. */
function shuffle<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'NonError';
}
