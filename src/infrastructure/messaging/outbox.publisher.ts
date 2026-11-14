import { PublishBatchCommand, SNSClient } from '@aws-sdk/client-sns';
import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Clock } from '../../application/ports';
import { CLOCK } from '../../application/tokens';
import type { Env } from '../../config/env';
import { ENV } from '../../config/env.token';
import type { OutboxMessage } from '../../domain/outbox-message';
import { JsonLogger } from '../logging/json-logger';
import { Metrics } from '../metrics/metrics';
import { toOutboxMessage } from '../persistence/mappers';
import { OutboxMessageRecord } from '../persistence/records';
import { SNS_CLIENT } from './sns.provider';

export interface PublishOutcome {
  published: number;
  failed: number;
}

/**
 * Publishes committed outbox rows to the SNS FIFO topic in every instance (ADR-04, ADR-11). One
 * batch is one transaction: lock up to `OUTBOX_BATCH_SIZE` due rows `FOR UPDATE SKIP LOCKED`, one
 * bounded `PublishBatch`, then mark each row published or schedule its retry, and commit. Other
 * publishers skip the locked rows; a publisher that dies releases them with its connection, and a
 * crash after the publish and before the commit publishes them again under the same event id, which
 * the broker deduplicates for five minutes and consumers by `eventId` after that.
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly orm: MikroORM,
    @Inject(SNS_CLIENT) private readonly sns: SNSClient,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: JsonLogger,
    private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(this.env.OUTBOX_POLL_INTERVAL_MS);
  }

  /** Runs before the ORM and the SNS client close: the batch in flight commits or rolls back. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    this.logger.info('outbox publisher stopped');
  }

  /** One batch. Nothing is due, or every row is locked by another publisher: `{ 0, 0 }`. */
  async publishDue(): Promise<PublishOutcome> {
    const outcome = await this.orm.em.fork().transactional(async (em) => {
      const now = this.clock.now();
      const rows = await em.find(
        OutboxMessageRecord,
        { publishedAt: null, nextAttemptAt: { $lte: now } },
        {
          orderBy: { nextAttemptAt: 'asc', id: 'asc' },
          limit: this.env.OUTBOX_BATCH_SIZE,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
          disableIdentityMap: true,
        },
      );
      if (rows.length === 0) return { published: 0, failed: 0 };
      const messages = rows.map(toOutboxMessage);

      const sent = await this.publish(messages);
      const at = this.clock.now();
      const published = messages.filter((message) => sent.has(message.id));
      const failed = messages.filter((message) => !sent.has(message.id));
      for (const message of published) message.markPublished(at);
      for (const message of failed) {
        message.scheduleRetry(at, {
          baseDelayMs: this.env.OUTBOX_RETRY_BASE_DELAY_MS,
          maxDelayMs: this.env.OUTBOX_RETRY_MAX_DELAY_MS,
        });
      }

      if (published.length > 0) {
        await em.nativeUpdate(
          OutboxMessageRecord,
          { id: { $in: published.map((message) => message.id) } },
          { publishedAt: at },
        );
      }
      for (const message of failed) {
        await em.nativeUpdate(
          OutboxMessageRecord,
          { id: message.id },
          { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt },
        );
      }

      this.logger.info('outbox batch published', {
        published: published.length,
        failed: failed.length,
      });
      return { published: published.length, failed: failed.length };
    });
    // After the commit: a rolled-back batch rescheduled nothing.
    if (outcome.failed > 0) this.metrics.retries.inc({ source: 'outbox' }, outcome.failed);
    return outcome;
  }

  /** The ids the broker accepted. A call that fails or times out accepted none. */
  private async publish(messages: OutboxMessage[]): Promise<Set<string>> {
    // ADR-09 failpoints: the batch is locked and nothing is published, or it is published and the
    // commit that records it never happens.
    if (this.env.OUTBOX_PUBLISHER_FAILPOINT === 'crash-before-publish') {
      process.kill(process.pid, 'SIGKILL');
    }
    try {
      const result = await this.sns.send(
        new PublishBatchCommand({
          TopicArn: this.env.WAGER_EVENTS_TOPIC_ARN,
          PublishBatchRequestEntries: messages.map((message) => ({
            Id: message.id,
            Message: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
            },
          })),
        }),
        { abortSignal: AbortSignal.timeout(this.env.OUTBOX_PUBLISH_TIMEOUT_MS) },
      );
      if (this.env.OUTBOX_PUBLISHER_FAILPOINT === 'crash-after-publish') {
        process.kill(process.pid, 'SIGKILL');
      }
      for (const entry of result.Failed ?? []) {
        this.logger.warn('outbox event not published', {
          eventId: entry.Id,
          code: entry.Code,
          senderFault: entry.SenderFault,
        });
      }
      return new Set((result.Successful ?? []).map((entry) => entry.Id ?? ''));
    } catch (error) {
      // Only the name: an SDK message can quote the request.
      this.logger.warn('outbox publish failed', { errorName: errorName(error) });
      return new Set();
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.publishDue()
        .then(({ published }) => published === this.env.OUTBOX_BATCH_SIZE)
        .catch((error: unknown) => {
          this.logger.warn('outbox poll failed', { errorName: errorName(error) });
          return false;
        })
        .then((more) => {
          this.running = undefined;
          // A full batch that went out: more rows may be due, so poll at once.
          this.schedule(more ? 0 : this.env.OUTBOX_POLL_INTERVAL_MS);
        });
    }, delayMs);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'NonError';
}
