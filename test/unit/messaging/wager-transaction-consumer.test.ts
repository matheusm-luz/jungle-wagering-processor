import { describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { ProcessWagerTransaction } from '../../../src/application/process-wager-transaction';
import { loadEnv } from '../../../src/config/env';
import { JsonLogger } from '../../../src/infrastructure/logging/json-logger';
import { WagerTransactionConsumer } from '../../../src/infrastructure/messaging/wager-transaction.consumer';
import { Metrics } from '../../../src/infrastructure/metrics/metrics';

const env = (overrides: Record<string, string>) =>
  loadEnv({
    DATABASE_URL: 'postgresql://wagering:wagering@localhost:5432/wagering',
    SQS_WAIT_TIME_S: '0',
    ...overrides,
  });

const silent = new JsonLogger({ level: 'silent', write: () => {} });

const body = JSON.stringify({
  messageId: 'msg-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-11-13T18:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    idempotencyKey: 'provider-a:tx-1',
    playerId: 'player-1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('condition not met');
    await Bun.sleep(5);
  }
}

/** A use case whose every call hangs: the message stays in flight. */
const hangingUseCase = (calls: { n: number }) =>
  ({
    executeMessage: () => {
      calls.n++;
      return new Promise(() => {});
    },
  }) as unknown as ProcessWagerTransaction;

describe('WagerTransactionConsumer shutdown (PR #9 review)', () => {
  test('a loop still resolving the queue url when SIGTERM arrives opens no long poll', async () => {
    let resolveUrl = () => {};
    const urlAnswered = new Promise<void>((resolve) => {
      resolveUrl = resolve;
    });
    const sent: string[] = [];
    const sqs = {
      send: async (command: unknown) => {
        sent.push((command as object).constructor.name);
        if (command instanceof GetQueueUrlCommand) {
          await urlAnswered;
          return { QueueUrl: `http://sqs/${command.input.QueueName}` };
        }
        return { Messages: [] };
      },
    } as unknown as SQSClient;
    const consumer = new WagerTransactionConsumer(
      hangingUseCase({ n: 0 }),
      sqs,
      env({ SQS_CONSUMER_CONCURRENCY: '1' }),
      silent,
      new Metrics(),
    );

    consumer.onApplicationBootstrap();
    await until(() => sent.includes('GetQueueUrlCommand'));
    await consumer.beforeApplicationShutdown();
    resolveUrl();
    await Bun.sleep(50);

    expect(sent).not.toContain('ReceiveMessageCommand');
  });

  test('a message still in flight gets its visibility back although SQS can no longer resolve the queue url', async () => {
    let sqsDown = false;
    let receives = 0;
    const returned: unknown[] = [];
    const sqs = {
      send: async (command: unknown) => {
        if (command instanceof GetQueueUrlCommand) {
          if (sqsDown) throw new Error('sqs down');
          return { QueueUrl: `http://sqs/${command.input.QueueName}` };
        }
        if (command instanceof ReceiveMessageCommand) {
          receives++;
          if (receives === 1) {
            return {
              Messages: [{ MessageId: 'broker-1', ReceiptHandle: 'handle-1', Body: body }],
            };
          }
          // The other loop's receive fails: the cached urls are dropped and SQS stays down.
          sqsDown = true;
          throw new Error('sqs down');
        }
        if (command instanceof ChangeMessageVisibilityCommand) {
          returned.push(command.input);
          return {};
        }
        return {};
      },
    } as unknown as SQSClient;
    const calls = { n: 0 };
    const consumer = new WagerTransactionConsumer(
      hangingUseCase(calls),
      sqs,
      env({ SQS_CONSUMER_CONCURRENCY: '2', SQS_SHUTDOWN_GRACE_MS: '10' }),
      silent,
      new Metrics(),
    );

    consumer.onApplicationBootstrap();
    await until(() => calls.n === 1 && sqsDown);
    await consumer.beforeApplicationShutdown();

    expect(returned).toEqual([
      {
        QueueUrl: 'http://sqs/wager-transactions.fifo',
        ReceiptHandle: 'handle-1',
        VisibilityTimeout: 0,
      },
    ]);
  });
});
