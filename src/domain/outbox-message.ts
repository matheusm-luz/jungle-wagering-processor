import { InvalidOutboxTransitionError } from './errors';

/** ADR-04: how a row whose publication failed waits before the next one. Values come from the caller. */
export interface OutboxRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface OutboxMessageState {
  /** The event id. */
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
}

/** What `enqueue` reads from an integration event: its envelope and identity. */
export interface EnqueuedEvent {
  eventId: string;
  aggregateId: string;
  eventType: string;
  occurredAt: Date;
  toJSON(): object;
}

/**
 * One integration event waiting to leave through the outbox (statement §6.5, §11). Written in the
 * transaction that produced the event; the publisher marks it published or schedules a retry.
 * There is no last attempt: an event is never dropped (ADR-04).
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    private readonly occurredAtMs: number,
    private _attempts: number,
    private nextAttemptAtMs: number,
    private publishedAtMs: number | undefined,
  ) {}

  /** A pending row with no attempt, due when the event occurred. */
  static enqueue(event: EnqueuedEvent): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: { ...event.toJSON() },
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: undefined,
    });
  }

  /** Rebuilds a persisted row. Validates nothing. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt.getTime(),
      state.attempts,
      state.nextAttemptAt.getTime(),
      state.publishedAt?.getTime(),
    );
  }

  get occurredAt(): Date {
    return new Date(this.occurredAtMs);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return new Date(this.nextAttemptAtMs);
  }

  get publishedAt(): Date | undefined {
    return this.publishedAtMs === undefined ? undefined : new Date(this.publishedAtMs);
  }

  isPending(): boolean {
    return this.publishedAtMs === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.nextAttemptAtMs <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this.publishedAtMs = at.getTime();
  }

  /** Counts a failed publication and waits `min(max, base × 2^(attempts-1))` before the next. */
  scheduleRetry(now: Date, policy: OutboxRetryPolicy): void {
    this.assertPending();
    this._attempts += 1;
    const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (this._attempts - 1));
    this.nextAttemptAtMs = now.getTime() + delayMs;
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidOutboxTransitionError(`Outbox message ${this.id} is already published`);
    }
  }
}
