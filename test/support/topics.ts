import { CreateTopicCommand, DeleteTopicCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { createSnsClient } from '../../src/infrastructure/messaging/sns.provider';
import { testEnv } from './database';
import { sqs } from './queues';

const sns = createSnsClient(testEnv);

export interface ReceivedEvent {
  /** The parsed body: the stored envelope. */
  readonly body: { eventId: string; eventType: string; aggregateId: string } & Record<
    string,
    unknown
  >;
  readonly groupId: string | undefined;
  readonly dedupId: string | undefined;
  readonly eventType: string | undefined;
}

export interface TestTopic {
  /** Environment value that points an instance's publisher at this topic. */
  readonly env: { WAGER_EVENTS_TOPIC_ARN: string };
  /** One receive of up to 10 messages from the subscriber, deleted once read. */
  take(): Promise<ReceivedEvent[]>;
  /** Takes until `done(all)` holds or `timeoutMs` passes; returns everything taken. */
  collect(done: (all: ReceivedEvent[]) => boolean, timeoutMs?: number): Promise<ReceivedEvent[]>;
  remove(): Promise<void>;
}

/**
 * A private SNS FIFO topic and a FIFO subscriber queue with raw delivery, as
 * infra/localstack/init/10-messaging.sh makes the real ones (ADR-11), so each suite reads only the
 * events its own publisher sent.
 */
export async function createTestTopic(prefix: string): Promise<TestTopic> {
  const base = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const { TopicArn } = await sns.send(
    new CreateTopicCommand({ Name: `${base}.fifo`, Attributes: { FifoTopic: 'true' } }),
  );
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${base}-subscriber.fifo`,
      Attributes: { FifoQueue: 'true' },
    }),
  );
  if (TopicArn === undefined || QueueUrl === undefined) throw new Error(`no topic for ${base}`);
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  await sns.send(
    new SubscribeCommand({
      TopicArn,
      Protocol: 'sqs',
      Endpoint: Attributes?.QueueArn,
      Attributes: { RawMessageDelivery: 'true' },
    }),
  );

  const take = async (): Promise<ReceivedEvent[]> => {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    for (const { ReceiptHandle } of Messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle }));
    }
    return Messages.map((message) => ({
      body: JSON.parse(message.Body ?? '{}'),
      groupId: message.Attributes?.MessageGroupId,
      dedupId: message.Attributes?.MessageDeduplicationId,
      eventType: message.MessageAttributes?.eventType?.StringValue,
    }));
  };

  return {
    env: { WAGER_EVENTS_TOPIC_ARN: TopicArn },
    take,
    collect: async (done, timeoutMs = 20_000) => {
      const all: ReceivedEvent[] = [];
      const deadline = performance.now() + timeoutMs;
      while (!done(all) && performance.now() < deadline) all.push(...(await take()));
      return all;
    },
    remove: async () => {
      await sns.send(new DeleteTopicCommand({ TopicArn }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl }));
    },
  };
}
