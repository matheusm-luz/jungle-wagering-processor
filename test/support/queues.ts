import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.provider';
import { testEnv } from './database';

export const sqs = createSqsClient(testEnv);

/** Matches infra/localstack/init/10-messaging.sh. */
const MAX_RECEIVE_COUNT = 5;

export interface TestQueues {
  /** Environment values that point an instance at this pair. */
  readonly env: { WAGER_TRANSACTIONS_QUEUE_NAME: string; WAGER_TRANSACTIONS_DLQ_NAME: string };
  readonly url: string;
  readonly dlqUrl: string;
  /** Sends a body as is. The deduplication id defaults to a fresh one, so a resend is a new copy. */
  sendRaw(body: string, options?: { groupId?: string; dedupId?: string }): Promise<void>;
  /** Visible plus in-flight messages. */
  depth(url: string): Promise<number>;
  /**
   * Receives what `url` holds within `timeoutMs`, leaving every message visible (visibility 0),
   * so a test can look without taking it from a consumer.
   */
  peek(url: string, timeoutMs?: number): Promise<Message[]>;
  /**
   * One receive of up to 10 messages, deleted once read: a message left in flight would block the
   * rest of its FIFO group.
   */
  take(url: string): Promise<Message[]>;
  remove(): Promise<void>;
}

/**
 * A fresh FIFO queue and its DLQ, with the redrive policy of the real ones: each suite runs its own
 * consumer without sharing a queue with another suite or a leftover message.
 */
export async function createTestQueues(prefix: string): Promise<TestQueues> {
  const base = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const dlqName = `${base}-dlq.fifo`;
  const name = `${base}.fifo`;
  const create = async (QueueName: string, attributes: Record<string, string> = {}) => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName, Attributes: { FifoQueue: 'true', ...attributes } }),
    );
    if (QueueUrl === undefined) throw new Error(`no url for ${QueueName}`);
    return QueueUrl;
  };

  const dlqUrl = await create(dlqName);
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const url = await create(name, {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: Attributes?.QueueArn,
      maxReceiveCount: String(MAX_RECEIVE_COUNT),
    }),
  });

  return {
    env: { WAGER_TRANSACTIONS_QUEUE_NAME: name, WAGER_TRANSACTIONS_DLQ_NAME: dlqName },
    url,
    dlqUrl,
    sendRaw: async (body, { groupId = 'group-1', dedupId = crypto.randomUUID() } = {}) => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: url,
          MessageBody: body,
          MessageGroupId: groupId,
          MessageDeduplicationId: dedupId,
        }),
      );
    },
    depth: async (queueUrl) => {
      const { Attributes: counts } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return (
        Number(counts?.ApproximateNumberOfMessages ?? 0) +
        Number(counts?.ApproximateNumberOfMessagesNotVisible ?? 0)
      );
    },
    peek: async (queueUrl, timeoutMs = 3000) => {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            VisibilityTimeout: 0,
            WaitTimeSeconds: 1,
            MessageAttributeNames: ['All'],
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );
        if (Messages.length > 0 || performance.now() > deadline) return Messages;
      }
    },
    take: async (queueUrl) => {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
        }),
      );
      for (const { ReceiptHandle } of Messages) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle }));
      }
      return Messages;
    },
    remove: async () => {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    },
  };
}

/** Statement §10 message for `data`. */
export function wagerMessage(
  data: Record<string, unknown>,
  messageId = `msg-${crypto.randomUUID()}`,
) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-11-13T18:00:00.000Z',
    data,
  };
}
