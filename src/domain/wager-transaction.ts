import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerAccountKind, type LedgerCounterparty } from './ledger-account';
import type { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Internal: the opening credit of a wallet. Never accepted from a provider. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not applied yet. In-memory only: it is never committed (L-06). */
  Pending = 'PENDING',
  /** Waiting for the transaction it references. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied. Terminal. */
  Processed = 'PROCESSED',
  /** A business rule was violated. Terminal. */
  Rejected = 'REJECTED',
  /** Permanent non-business error. Terminal, kept for audit. */
  Failed = 'FAILED',
}

const Kind = WagerTransactionKind;
const Status = WagerTransactionStatus;

/** The kinds a provider may submit, over HTTP or the queue. `OPENING` is not one of them. */
export const SUBMITTABLE_KINDS = [
  Kind.Bet,
  Kind.Win,
  Kind.Loss,
  Kind.Refund,
  Kind.Rollback,
] as const satisfies readonly WagerTransactionKind[];

/** The kinds that cannot exist without `referenceExternalTransactionId` (statement §7.1). */
const REQUIRES_REFERENCE: readonly WagerTransactionKind[] = [Kind.Refund, Kind.Rollback];

/** The kinds each kind may reference (statement §7, L-09). A kind missing here refuses a reference. */
const REFERENCEABLE: Readonly<
  Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>
> = {
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
};

/**
 * The whole state machine (ARCHITECTURE §5). A status that maps to an empty list is terminal.
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [Status.Pending]: [Status.Processed, Status.Rejected, Status.PendingReference, Status.Failed],
  [Status.PendingReference]: [Status.Processed, Status.Rejected, Status.Failed],
  [Status.Processed]: [],
  [Status.Rejected]: [],
  [Status.Failed]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** The id the provider gave to the referenced transaction, not an internal id. */
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  referenceExternalTransactionId: string | undefined;
  status: WagerTransactionStatus;
  /** Internal id of the referenced transaction, once resolved. */
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  /** Wallet balance seen when the current status was reached; a replay answers with it. */
  observedBalance: Money | undefined;
  processedAt: Date | undefined;
}

/**
 * One operation sent by a provider (or the internal opening credit) and its outcome.
 * The row is also the idempotency record: a replay is answered from this state (ADR-03).
 */
export class WagerTransaction {
  /** Instants are kept as epoch milliseconds, so a `Date` handed out cannot change the transaction. */
  private readonly createdAtMs: number;
  private processedAtMs: number | undefined;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _observedBalance: Money | undefined,
    processedAt: Date | undefined,
  ) {
    this.createdAtMs = createdAt.getTime();
    this.processedAtMs = processedAt?.getTime();
  }

  /**
   * A new transaction, `PENDING`. Enforces what the transaction can check alone: the identifiers
   * that uniqueness is built on, whether its kind requires, accepts or refuses a reference (L-18),
   * and the sign of the amount (L-03). Rules that need the wallet or the referenced transaction are
   * checked later, by the use case.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId: reference } = props;

    // An empty idempotency key would make every keyless request collide on one row.
    for (const field of ['idempotencyKey', 'providerId', 'externalTransactionId'] as const) {
      if (props[field].length === 0) {
        throw new InvalidTransactionError(`${field} cannot be empty`);
      }
    }

    if (reference === props.externalTransactionId) {
      throw new InvalidTransactionError('A transaction cannot reference itself');
    }

    if (reference === undefined) {
      if (REQUIRES_REFERENCE.includes(kind)) {
        throw new InvalidTransactionError(`${kind} requires referenceExternalTransactionId`);
      }
    } else {
      if (kind === Kind.Bet || kind === Kind.Opening) {
        throw new InvalidTransactionError(`${kind} does not accept a reference`);
      }
      if (reference.length === 0) {
        throw new InvalidTransactionError('referenceExternalTransactionId cannot be empty');
      }
    }

    if (kind === Kind.Loss ? money.isNegative() : !money.isPositive()) {
      throw new InvalidTransactionError(
        kind === Kind.Loss
          ? 'LOSS requires a zero or positive amount'
          : `${kind} requires a positive amount`,
      );
    }

    return WagerTransaction.rehydrate({
      ...props,
      referenceExternalTransactionId: reference,
      status: Status.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      observedBalance: undefined,
      processedAt: undefined,
    });
  }

  /** Rebuilds a persisted transaction. Validates nothing, transitions included. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.observedBalance,
      state.processedAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get processedAt(): Date | undefined {
    return this.processedAtMs === undefined ? undefined : new Date(this.processedAtMs);
  }

  // ---- Transitions. Each one checks before it assigns: a refused transition changes nothing.

  /**
   * @param referenceTransactionId internal id of the resolved reference; present exactly when the
   *   transaction declared one.
   * @param observedBalance wallet balance right after the movement (unchanged for `LOSS`).
   */
  markProcessed(
    referenceTransactionId: string | undefined,
    observedBalance: Money,
    at: Date,
  ): void {
    this.assertCanBecome(Status.Processed);
    if (
      (referenceTransactionId === undefined) !==
      (this.referenceExternalTransactionId === undefined)
    ) {
      throw new InvalidTransactionStateError(
        'A resolved reference must be given exactly when the transaction declares one',
      );
    }

    this._status = Status.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this.processedAtMs = at.getTime();
  }

  markPendingReference(observedBalance: Money): void {
    this.assertCanBecome(Status.PendingReference);
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(
        'A transaction without a reference cannot wait for one',
      );
    }

    this._status = Status.PendingReference;
    this._observedBalance = observedBalance;
  }

  /**
   * A business rule was violated. The balance did not move; `observedBalance` is what it was.
   * Takes any code except `PROCESSING_FAILED`, which belongs to `FAILED` (ARCHITECTURE §6).
   */
  reject(code: FailureCode, observedBalance: Money): void {
    this.assertCanBecome(Status.Rejected);
    if (code === FailureCode.ProcessingFailed) {
      throw new InvalidTransactionStateError(`${code} is not a business rejection`);
    }

    this._status = Status.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
  }

  /** A permanent non-business error. Takes only `PROCESSING_FAILED` (ARCHITECTURE §6). */
  fail(code: FailureCode): void {
    this.assertCanBecome(Status.Failed);
    if (code !== FailureCode.ProcessingFailed) {
      throw new InvalidTransactionStateError(`${code} is a business rejection, not a failure`);
    }

    this._status = Status.Failed;
    this._failureCode = code;
  }

  // ---- Domain queries.

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  /** `false` for `LOSS`, which records an outcome and creates no ledger entry. */
  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  requiresReference(): boolean {
    return REQUIRES_REFERENCE.includes(this.kind);
  }

  /** Same idempotency key and same hash is a replay; a different hash is a conflict. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Which way this transaction moves the wallet. Only `ROLLBACK` depends on the reference: it
   * undoes a `BET` with a credit and a `WIN` or `REFUND` with a debit (statement §7.3).
   *
   * A `reference`, when given, must be the one this transaction declared: handing in another
   * transaction would invert the direction of the money without any error.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (reference !== undefined) this.assertDeclaredReference(reference);

    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Win:
      case Kind.Refund:
      case Kind.Opening:
        return LedgerDirection.Credit;
      case Kind.Rollback:
        switch (reference?.kind) {
          case Kind.Bet:
            return LedgerDirection.Credit;
          case Kind.Win:
          case Kind.Refund:
            return LedgerDirection.Debit;
          default:
            throw new InvalidTransactionError('ROLLBACK can only invert a BET, a WIN or a REFUND');
        }
      case Kind.Loss:
        throw new InvalidTransactionError('LOSS does not move the balance');
    }
  }

  /**
   * The first reference rule (statement §7) that `reference` breaks, in the order ownership, kind,
   * status, amount, single reversal; undefined when it breaks none. Amount and single reversal
   * bind only `REFUND` and `ROLLBACK`: a `WIN` pays another amount, and a `WIN` of a reversed `BET`
   * is accepted (docs/tasks/S6.md, Q2). A reference still `PENDING_REFERENCE` breaks no status
   * rule: the caller waits for it (L-10).
   *
   * @param alreadyReversed whether `reference` already has a `PROCESSED` `REFUND` or `ROLLBACK` (L-01).
   */
  referenceFailure(reference: WagerTransaction, alreadyReversed: boolean): FailureCode | undefined {
    this.assertDeclaredReference(reference);
    const isReversal = REQUIRES_REFERENCE.includes(this.kind);

    if (
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (!REFERENCEABLE[this.kind]?.includes(reference.kind)) {
      return FailureCode.ReferenceKindNotAllowed;
    }
    if (reference.status === Status.Rejected || reference.status === Status.Failed) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (isReversal && !reference.money.equals(this.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    if (isReversal && alreadyReversed) {
      return FailureCode.ReferenceAlreadyReversed;
    }
    return undefined;
  }

  /**
   * The system account on the other side of this transaction's ledger entry (ADR-12): `OPENING`
   * posts against `FUNDING`, gameplay against the settlement account of its provider.
   */
  counterparty(): LedgerCounterparty {
    switch (this.kind) {
      case Kind.Opening:
        return { kind: LedgerAccountKind.Funding };
      case Kind.Bet:
      case Kind.Win:
      case Kind.Refund:
      case Kind.Rollback:
        return { kind: LedgerAccountKind.ProviderSettlement, providerId: this.providerId };
      case Kind.Loss:
        throw new InvalidTransactionError('LOSS does not move the balance');
    }
  }

  /** Handing in another transaction would apply the rules, or the direction, of the wrong one. */
  private assertDeclaredReference(reference: WagerTransaction): void {
    if (
      reference.providerId !== this.providerId ||
      reference.externalTransactionId !== this.referenceExternalTransactionId
    ) {
      throw new InvalidTransactionError('The transaction given is not the declared reference');
    }
  }

  private assertCanBecome(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(`Cannot go from ${this._status} to ${next}`);
    }
  }
}
