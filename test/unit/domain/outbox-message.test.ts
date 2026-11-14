import { describe, expect, test } from 'bun:test';
import { InvalidOutboxTransitionError } from '../../../src/domain/errors';
import { OutboxMessage } from '../../../src/domain/outbox-message';

const ADR_04 = { baseDelayMs: 1000, maxDelayMs: 60_000 };
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 14, 12, 0, seconds));

function pending(attempts = 0) {
  return OutboxMessage.rehydrate({
    id: 'event-1',
    aggregateId: 'wallet-1',
    eventType: 'WagerTransactionProcessed',
    payload: { eventId: 'event-1' },
    occurredAt: at(0),
    attempts,
    nextAttemptAt: at(0),
    publishedAt: undefined,
  });
}

describe('OutboxMessage (statement §6.5, ADR-04)', () => {
  test('enqueue makes a pending row with no attempt, due when the event occurred', () => {
    const event = {
      eventId: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      occurredAt: at(5),
      toJSON: () => ({ eventId: 'event-1', version: 1 }),
    };
    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual({ eventId: 'event-1', version: 1 });
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toEqual(at(5));
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at(4))).toBe(false);
    expect(message.isDue(at(5))).toBe(true);
  });

  test('the delay doubles per attempt and is capped; there is no last attempt', () => {
    const message = pending();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      const now = at(30);
      message.scheduleRetry(now, ADR_04);
      delays.push(message.nextAttemptAt.getTime() - now.getTime());
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    expect(message.attempts).toBe(9);
    expect(message.isPending()).toBe(true);
  });

  test('a published row is no longer pending nor due, and cannot be published or rescheduled again', () => {
    const message = pending(2);
    message.markPublished(at(10));

    expect(message.publishedAt).toEqual(at(10));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(60))).toBe(false);
    expect(() => message.markPublished(at(11))).toThrow(InvalidOutboxTransitionError);
    expect(() => message.scheduleRetry(at(11), ADR_04)).toThrow(InvalidOutboxTransitionError);
    expect(message.attempts).toBe(2);
  });

  test('rehydrate restores any state without validating', () => {
    const message = OutboxMessage.rehydrate({
      id: 'event-2',
      aggregateId: 'wallet-2',
      eventType: 'WagerTransactionRejected',
      payload: {},
      occurredAt: at(0),
      attempts: -1,
      nextAttemptAt: at(-5),
      publishedAt: at(1),
    });

    expect(message.attempts).toBe(-1);
    expect(message.publishedAt).toEqual(at(1));
  });

  test('dates read from the row cannot change it', () => {
    const message = pending();
    message.nextAttemptAt.setTime(0);
    message.occurredAt.setTime(0);

    expect(message.nextAttemptAt).toEqual(at(0));
    expect(message.occurredAt).toEqual(at(0));
  });
});
