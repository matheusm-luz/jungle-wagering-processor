import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../application/process-wager-transaction';
import type { Env } from '../../config/env';
import { ENV } from '../../config/env.token';
import { RequestValidationError } from '../http/request-validation.error';
import {
  idempotencyKeySchema,
  identifierSchema,
  money,
  parse,
  wagerSchema,
} from '../http/validation';
import { JsonLogger } from '../logging/json-logger';
import { addLogContext, runWithLogContext } from '../logging/log-context';
import { Metrics } from '../metrics/metrics';
import { classify, visibilityBackoff } from './consumer-policy';
import { SQS_CLIENT } from './sqs.provider';

/** The inbox key's consumer name (statement §10). */
export const CONSUMER_NAME = 'wager-transactions';

/** Statement §10 message, closed field list like the HTTP body. */
const envelopeSchema = z.strictObject({
  messageId: identifierSchema,
  type: z.literal('WagerTransactionRequested'),
  // Any ISO-8601 instant, with `Z` or an offset (S9 review, m7).
  occurredAt: z.iso.datetime({ offset: true }),
  data: wagerSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

interface QueueUrls {
  queue: string;
  dlq: string;
}

/**
 * Consumes `wager-transactions.fifo` in every instance (ADR-05). `SQS_CONSUMER_CONCURRENCY` loops
 * each receive one message at a time: SQS FIFO hands out nothing else of a group while one of its
 * messages is in flight, so per-wallet order holds across loops and instances (docs/tasks/S9.md Q3).
 *
 * - Any answer of the use case (it committed) → `DeleteMessage`. Never before the commit.
 * - Permanent error → copy to the DLQ, then delete: a crash in between re-sends the same
 *   deduplication id, never loses the message.
 * - Transient error → no ack, invisible for the backoff; the redrive policy dead-letters it after
 *   5 receives.
 */
@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private stopping = false;
  /** Interrupts the pause after a failed receive; never a receive itself. */
  private readonly stop = new AbortController();
  private readonly receiving = new Set<Promise<Message | undefined>>();
  /** By receipt handle, with the queue it came from: shutdown needs no url lookup (PR #9 review). */
  private readonly inFlight = new Map<string, { work: Promise<void>; queue: string }>();
  private urls: Promise<QueueUrls> | undefined;

  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: JsonLogger,
    private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    for (let i = 0; i < this.env.SQS_CONSUMER_CONCURRENCY; i++) void this.poll();
  }

  /**
   * R-56: no new receive. A long poll already open is not aborted: the broker may hand it a
   * message after the client gave up, which would then stay invisible for a whole visibility
   * timeout with no one working on it. It ends within `SQS_WAIT_TIME_S`, and a message it brings
   * is handed back at once. In-flight messages get the grace period to finish (commit and ack);
   * the ones still running then get their visibility back, so another instance takes them now.
   * If one commits later anyway, the inbox absorbs the redelivery.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.stop.abort();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const after = (ms: number) =>
      new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms)));
    await Promise.all([
      // Not cut by the grace period (S9 review, m5): a poll left behind would strand its message.
      // It ends within SQS_WAIT_TIME_S; the margin only guards against a broker that hangs.
      Promise.race([
        Promise.allSettled([...this.receiving]),
        after(this.env.SQS_WAIT_TIME_S * 1000 + 5000),
      ]),
      Promise.race([
        Promise.allSettled([...this.inFlight.values()].map(({ work }) => work)),
        after(this.env.SQS_SHUTDOWN_GRACE_MS),
      ]),
    ]);
    for (const timer of timers) clearTimeout(timer);

    const unfinished = [...this.inFlight];
    await Promise.all(
      unfinished.map(([handle, { queue }]) => this.changeVisibility(queue, handle, 0, 'shutdown')),
    );
    this.logger.info('sqs consumer stopped', { returned: unfinished.length });
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        const urls = await this.queueUrls();
        // SIGTERM may have come during the lookup. From here to `receiving.add` nothing yields, so
        // shutdown either sees this poll or it never starts (PR #9 review).
        if (this.stopping) return;
        const receive = this.receive(urls);
        this.receiving.add(receive);
        const message = await receive.finally(() => this.receiving.delete(receive));
        if (message !== undefined) await this.track(message, urls);
      } catch (error) {
        if (this.stopping) return;
        // Resolved again next time: the queue may not exist yet, or SQS may be down.
        this.urls = undefined;
        this.logger.warn('sqs receive failed', { errorName: errorName(error) });
        await sleep(1000, this.stop.signal);
      }
    }
  }

  /** One long poll for one message. A message that arrives once shutdown began is handed back. */
  private async receive(urls: QueueUrls): Promise<Message | undefined> {
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: urls.queue,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.env.SQS_WAIT_TIME_S,
        VisibilityTimeout: this.env.SQS_VISIBILITY_TIMEOUT_S,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    const [message] = Messages;
    if (message === undefined || !this.stopping) return message;
    if (message.ReceiptHandle !== undefined) {
      await this.changeVisibility(urls.queue, message.ReceiptHandle, 0, 'shutdown');
    }
    return undefined;
  }

  private async track(message: Message, urls: QueueUrls): Promise<void> {
    const handle = message.ReceiptHandle;
    if (handle === undefined) return;
    const work = this.handle(message, handle, urls).finally(() => this.inFlight.delete(handle));
    this.inFlight.set(handle, { work, queue: urls.queue });
    await work;
  }

  private async handle(message: Message, handle: string, urls: QueueUrls): Promise<void> {
    let command: ProcessWagerTransactionCommand;
    let messageId: string;
    try {
      ({ command, messageId } = toCommand(message.Body));
    } catch (error) {
      // Unreadable: no message id to log beyond the broker's.
      await this.deadLetter(message, handle, urls, error);
      return;
    }

    const context = {
      messageId,
      correlationId: command.correlationId,
      walletId: command.walletId,
      providerId: command.providerId,
    };
    await runWithLogContext(context, async () => {
      try {
        const timer = this.metrics.processing.startTimer({ channel: 'sqs' });
        const result = await this.processWagerTransaction
          .executeMessage(command, { consumerName: CONSUMER_NAME, messageId })
          .finally(timer);
        if (result === 'duplicate') {
          this.metrics.duplicates.inc({ channel: 'sqs' });
          this.logger.info('sqs message already processed');
        } else if (result === 'walletNotFound') {
          // L-08: acknowledged with its inbox row; nothing else is persisted.
          this.metrics.unknownWallet.inc();
          this.logger.warn('sqs message for an unknown wallet');
        } else {
          addLogContext({ transactionId: result.transaction.id });
          // The same key already sent over HTTP: a replay, not a new transaction (R-52).
          if (result.idempotentReplay) {
            this.metrics.duplicates.inc({ channel: 'sqs' });
          } else {
            this.metrics.transactions.inc({ channel: 'sqs', status: result.transaction.status });
          }
          this.logger.info('sqs message processed', { status: result.transaction.status });
        }
        // ADR-09 failpoint: committed, not acknowledged (R-68).
        if (this.env.SQS_CONSUMER_FAILPOINT === 'crash-after-commit') {
          process.kill(process.pid, 'SIGKILL');
        }
        await this.ack(urls.queue, handle);
      } catch (error) {
        if (classify(error) === 'permanent') {
          await this.deadLetter(message, handle, urls, error);
        } else {
          await this.retryLater(message, handle, urls, error);
        }
      }
    });
  }

  private async retryLater(
    message: Message,
    handle: string,
    urls: QueueUrls,
    error: unknown,
  ): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const delay = visibilityBackoff(
      receiveCount,
      this.env.SQS_RETRY_BASE_DELAY_S,
      this.env.SQS_RETRY_MAX_DELAY_S,
    );
    this.metrics.retries.inc({ source: 'sqs' });
    this.logger.warn('sqs message failed, retrying', {
      errorName: errorName(error),
      receiveCount,
      retryInSeconds: delay,
    });
    await this.changeVisibility(urls.queue, handle, delay, 'retry');
  }

  private async deadLetter(
    message: Message,
    handle: string,
    urls: QueueUrls,
    error: unknown,
  ): Promise<void> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: urls.dlq,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'unknown',
          // The broker's id: a re-send after a crash before the delete is deduplicated.
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            failureReason: { DataType: 'String', StringValue: errorName(error) },
          },
        }),
      );
    } catch (sendError) {
      // Not deleted: it comes back after its visibility timeout and is tried again.
      this.logger.error('sqs dead-letter failed', { errorName: errorName(sendError) });
      return;
    }
    this.metrics.deadLettered.inc();
    // Only the error's name and, for a validation error, field paths: never values (R-60).
    this.logger.warn('sqs message dead-lettered', {
      errorName: errorName(error),
      ...(error instanceof RequestValidationError ? { reason: error.message } : {}),
      sqsMessageId: message.MessageId,
    });
    await this.ack(urls.queue, handle);
  }

  /** A failed delete is a redelivery the inbox absorbs, never a second effect. */
  private async ack(queue: string, handle: string): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: handle }));
    } catch (error) {
      this.logger.warn('sqs ack failed', { errorName: errorName(error) });
    }
  }

  private async changeVisibility(
    queue: string,
    handle: string,
    seconds: number,
    reason: string,
  ): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queue,
          ReceiptHandle: handle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      // The message still comes back, after its current visibility timeout.
      this.logger.warn('sqs visibility change failed', { errorName: errorName(error), reason });
    }
  }

  private queueUrls(): Promise<QueueUrls> {
    this.urls ??= (async () => {
      const url = async (QueueName: string) => {
        const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName }));
        if (QueueUrl === undefined) throw new Error(`queue ${QueueName} has no url`);
        return QueueUrl;
      };
      return {
        queue: await url(this.env.WAGER_TRANSACTIONS_QUEUE_NAME),
        dlq: await url(this.env.WAGER_TRANSACTIONS_DLQ_NAME),
      };
    })();
    return this.urls;
  }
}

/** The use-case command of a message body; an unreadable or invalid body is a validation error. */
function toCommand(body: string | undefined): {
  command: ProcessWagerTransactionCommand;
  messageId: string;
} {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new RequestValidationError('(body): not JSON');
  }
  const envelope = parse(envelopeSchema, json);
  const { idempotencyKey, ...fields } = envelope.data;
  return {
    messageId: envelope.messageId,
    command: {
      ...fields,
      idempotencyKey,
      money: money('data.money', fields.money),
      // A redelivery keeps the same id, so its log lines and events correlate (L-15).
      correlationId: envelope.messageId,
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'NonError';
}
