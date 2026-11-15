import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { Gauge } from 'prom-client';
import type { Env } from '../../config/env';
import { ENV } from '../../config/env.token';
import { JsonLogger } from '../logging/json-logger';
import { SQS_CLIENT } from '../messaging/sqs.provider';
import { Metrics } from './metrics';

interface OutboxBacklog {
  pending: number;
  lag_seconds: number;
  max_attempts: number;
}

/**
 * Gauges read at scrape time (docs/tasks/S11.md, Q2): they see a stopped publisher and the redrive
 * policy's moves, which no counter of a running instance can. Every instance reads the same
 * database and queue, so a scraper takes their maximum, not their sum. A read that fails reports
 * NaN, never a stale value.
 * The PostgreSQL read is bounded by `DATABASE_STATEMENT_TIMEOUT_MS`; the SQS read by
 * `READINESS_TIMEOUT_MS`, like the readiness probes, so a slow SQS cannot stall a scrape.
 */
@Injectable()
export class BacklogGauges {
  private backlog: Promise<OutboxBacklog> | undefined;
  private dlqUrl: string | undefined;

  constructor(
    metrics: Metrics,
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: JsonLogger,
  ) {
    const registers = [metrics.registry];
    const outbox = (help: string, field: keyof OutboxBacklog) => ({
      help,
      registers,
      collect: this.read(`outbox ${field}`, async () => (await this.outbox())[field]),
    });
    new Gauge({
      name: 'outbox_lag_seconds',
      ...outbox(
        'Age of the oldest unpublished outbox event; 0 when none is pending',
        'lag_seconds',
      ),
    });
    new Gauge({
      name: 'outbox_pending_messages',
      ...outbox('Outbox events not yet published', 'pending'),
    });
    new Gauge({
      name: 'outbox_max_attempts',
      ...outbox('Highest failed publish attempts among unpublished events', 'max_attempts'),
    });
    new Gauge({
      name: 'sqs_dlq_messages',
      help: 'Approximate number of messages in the DLQ, from the consumer and the redrive policy',
      registers,
      collect: this.read('dlq depth', () => this.dlqDepth()),
    });
  }

  private read(what: string, value: () => Promise<number>) {
    const logger = this.logger;
    return async function (this: Gauge) {
      try {
        this.set(await value());
      } catch (error) {
        logger.warn('metric read failed', {
          metric: what,
          errorName: error instanceof Error ? error.name : 'NonError',
        });
        this.set(Number.NaN);
      }
    };
  }

  /** One query per scrape: the three outbox gauges are collected together and share it. */
  private outbox(): Promise<OutboxBacklog> {
    this.backlog ??= this.orm.em
      .getConnection()
      .execute<OutboxBacklog[]>(
        `select count(*)::int as pending,
                -- occurred_at is the instance's clock, now() the database's: a clock ahead would
                -- read as a negative lag (S11 review, m2).
                greatest(coalesce(extract(epoch from now() - min(occurred_at)), 0), 0)::float8
                  as lag_seconds,
                coalesce(max(attempts), 0)::int as max_attempts
           from outbox_messages
          where published_at is null`,
      )
      .then(([row]) => row as OutboxBacklog)
      .finally(() => {
        this.backlog = undefined;
      });
    return this.backlog;
  }

  private async dlqDepth(): Promise<number> {
    const abortSignal = AbortSignal.timeout(this.env.READINESS_TIMEOUT_MS);
    this.dlqUrl ??= (
      await this.sqs.send(
        new GetQueueUrlCommand({ QueueName: this.env.WAGER_TRANSACTIONS_DLQ_NAME }),
        { abortSignal },
      )
    ).QueueUrl;
    // The redrive policy's moves land visible; not visible are DLQ messages someone is reading.
    const { Attributes } = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
      { abortSignal },
    );
    return (
      Number(Attributes?.ApproximateNumberOfMessages ?? Number.NaN) +
      Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? Number.NaN)
    );
  }
}
