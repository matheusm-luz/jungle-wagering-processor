/** What the caller knows about the occurrence: ids and time come from outside, like everywhere in the domain. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  /** The id of the message that caused the event (the SQS `messageId`); absent over HTTP. */
  causationId?: string | undefined;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  /** The wallet id for every event: the wallet is the unit of ordering (ADR-11, L-14). */
  aggregateId: string;
  data: T;
}

export interface IntegrationEventJson<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/** Freezes a plain JSON value all the way down. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Envelope of every event written to the outbox (statement §11). `eventType` and `version` live on
 * the concrete class, never in a loose string at the call site. `data` is plain JSON: amounts are
 * `MoneyProps`, never a `Money`, so the payload stays stable and versionable.
 */
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;
  private readonly occurredAtMs: number;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAtMs = props.occurredAt.getTime();
    this.data = deepFreeze(props.data);
  }

  /**
   * Freezes the instance once the subclass has set `eventType` and `version`. Field initialisers of
   * a subclass run after this constructor, so the base cannot freeze in its own constructor.
   */
  protected seal(): void {
    Object.freeze(this);
  }

  get occurredAt(): Date {
    return new Date(this.occurredAtMs);
  }

  /** The serialised envelope stored in the outbox payload. */
  toJSON(): IntegrationEventJson<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}
