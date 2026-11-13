import { describe, expect, test } from 'bun:test';
import { InvalidTransactionError, InvalidTransactionStateError } from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/failure-code';
import { LedgerAccountKind } from '../../../src/domain/ledger-account';
import { Money } from '../../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  SUBMITTABLE_KINDS,
  WagerTransaction,
  type WagerTransactionState,
} from '../../../src/domain/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const CREATED_AT = new Date('2026-11-13T01:00:00.000Z');
const PROCESSED_AT = new Date('2026-11-13T01:00:01.000Z');
const BALANCE = brl('975.00');

const ALL_KINDS = Object.values(Kind);
const ALL_STATUSES = Object.values(Status);

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** A valid transaction of the given kind, still `PENDING`. */
function ofKind(kind: Kind): WagerTransaction {
  const needsReference = kind === Kind.Refund || kind === Kind.Rollback;
  return WagerTransaction.create(
    props(needsReference ? { kind, referenceExternalTransactionId: 'transaction-100' } : { kind }),
  );
}

/** The transaction that `ofKind(REFUND)` and `ofKind(ROLLBACK)` declare as their reference. */
function referenced(kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}) {
  const needsReference = kind === Kind.Refund || kind === Kind.Rollback;
  return WagerTransaction.create(
    props({
      kind,
      id: 'tx-100',
      externalTransactionId: 'transaction-100',
      idempotencyKey: 'provider-a:transaction-100',
      ...(needsReference ? { referenceExternalTransactionId: 'transaction-050' } : {}),
      ...overrides,
    }),
  );
}

/** A persisted `REFUND` (so every transition is applicable) in the given status. */
function inStatus(status: Status): WagerTransaction {
  const state: WagerTransactionState = {
    ...props({ kind: Kind.Refund }),
    referenceExternalTransactionId: 'transaction-100',
    status,
    referenceTransactionId: undefined,
    failureCode: undefined,
    observedBalance: undefined,
    processedAt: undefined,
  };
  return WagerTransaction.rehydrate(state);
}

function snapshot(transaction: WagerTransaction) {
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId,
    failureCode: transaction.failureCode,
    observedBalance: transaction.observedBalance?.amount,
    processedAt: transaction.processedAt,
  };
}

const TRANSITIONS: Record<string, (transaction: WagerTransaction) => void> = {
  [Status.Processed]: (transaction) => transaction.markProcessed('tx-ref', BALANCE, PROCESSED_AT),
  [Status.PendingReference]: (transaction) => transaction.markPendingReference(BALANCE),
  [Status.Rejected]: (transaction) => transaction.reject(FailureCode.ReferenceNotFound, BALANCE),
  [Status.Failed]: (transaction) => transaction.fail(FailureCode.ProcessingFailed),
};

describe('WagerTransaction creation', () => {
  test('is born PENDING', () => {
    const transaction = WagerTransaction.create(props());

    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(snapshot(transaction)).toEqual({
      status: Status.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      observedBalance: undefined,
      processedAt: undefined,
    });

    expect(transaction.id).toBe('tx-1');
    expect(transaction.providerId).toBe('provider-a');
    expect(transaction.externalTransactionId).toBe('transaction-123');
    expect(transaction.idempotencyKey).toBe('provider-a:transaction-123');
    expect(transaction.payloadHash).toBe('hash-1');
    expect(transaction.walletId).toBe('wallet-1');
    expect(transaction.playerId).toBe('player-1');
    expect(transaction.roundId).toBe('round-987');
    expect(transaction.gameId).toBe('fortune-chimp');
    expect(transaction.kind).toBe(Kind.Bet);
    expect(transaction.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(transaction.referenceExternalTransactionId).toBeUndefined();
    expect(transaction.createdAt).toEqual(CREATED_AT);
  });

  test('REFUND and ROLLBACK require a reference', () => {
    for (const kind of [Kind.Refund, Kind.Rollback]) {
      expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidTransactionError);
      expect(() =>
        WagerTransaction.create(props({ kind, referenceExternalTransactionId: '' })),
      ).toThrow(InvalidTransactionError);

      const transaction = WagerTransaction.create(
        props({ kind, referenceExternalTransactionId: 'transaction-100' }),
      );
      expect(transaction.requiresReference()).toBe(true);
      expect(transaction.referenceExternalTransactionId).toBe('transaction-100');
    }

    for (const kind of [Kind.Opening, Kind.Bet, Kind.Win, Kind.Loss]) {
      expect(ofKind(kind).requiresReference()).toBe(false);
    }
  });

  test('BET and OPENING refuse a reference; WIN and LOSS accept one', () => {
    for (const kind of [Kind.Bet, Kind.Opening]) {
      expect(() =>
        WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'transaction-100' })),
      ).toThrow(InvalidTransactionError);
    }

    for (const kind of [Kind.Win, Kind.Loss]) {
      const transaction = WagerTransaction.create(
        props({ kind, referenceExternalTransactionId: 'transaction-100' }),
      );
      expect(transaction.referenceExternalTransactionId).toBe('transaction-100');
      expect(() =>
        WagerTransaction.create(props({ kind, referenceExternalTransactionId: '' })),
      ).toThrow(InvalidTransactionError);
    }
  });

  test('BET, WIN, REFUND, ROLLBACK and OPENING require a positive amount; LOSS accepts zero', () => {
    const reference = { referenceExternalTransactionId: 'transaction-100' };
    const zero = Money.zero('BRL');
    const negative = brl('25.00').negate();

    for (const kind of [Kind.Bet, Kind.Win, Kind.Opening]) {
      expect(() => WagerTransaction.create(props({ kind, money: zero }))).toThrow(
        InvalidTransactionError,
      );
      expect(() => WagerTransaction.create(props({ kind, money: negative }))).toThrow(
        InvalidTransactionError,
      );
    }
    for (const kind of [Kind.Refund, Kind.Rollback]) {
      expect(() => WagerTransaction.create(props({ kind, money: zero, ...reference }))).toThrow(
        InvalidTransactionError,
      );
      expect(() => WagerTransaction.create(props({ kind, money: negative, ...reference }))).toThrow(
        InvalidTransactionError,
      );
    }

    expect(WagerTransaction.create(props({ kind: Kind.Loss, money: zero })).money.isZero()).toBe(
      true,
    );
    expect(WagerTransaction.create(props({ kind: Kind.Loss })).money.amount).toBe('25.00');
    expect(() => WagerTransaction.create(props({ kind: Kind.Loss, money: negative }))).toThrow(
      InvalidTransactionError,
    );
  });

  test('requires the identifiers that uniqueness is built on', () => {
    // An empty idempotency key would make every keyless request collide on one row.
    for (const field of ['idempotencyKey', 'providerId', 'externalTransactionId'] as const) {
      expect(() => WagerTransaction.create(props({ [field]: '' }))).toThrow(
        InvalidTransactionError,
      );
    }
  });

  test('refuses a transaction that references itself', () => {
    for (const kind of [Kind.Refund, Kind.Rollback, Kind.Win, Kind.Loss]) {
      expect(() =>
        WagerTransaction.create(
          props({
            kind,
            externalTransactionId: 'transaction-123',
            referenceExternalTransactionId: 'transaction-123',
          }),
        ),
      ).toThrow(InvalidTransactionError);
    }
  });

  test('exposes dates that cannot be used to change it', () => {
    const transaction = ofKind(Kind.Bet);
    transaction.markProcessed(undefined, BALANCE, PROCESSED_AT);

    transaction.createdAt.setFullYear(1999);
    transaction.processedAt?.setFullYear(1999);

    expect(transaction.createdAt).toEqual(CREATED_AT);
    expect(transaction.processedAt).toEqual(PROCESSED_AT);
  });

  test('OPENING is not submittable', () => {
    expect([...SUBMITTABLE_KINDS].sort()).toEqual(
      [Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback].sort(),
    );
    expect(SUBMITTABLE_KINDS).not.toContain(Kind.Opening);
  });
});

describe('WagerTransaction queries', () => {
  test('affectsBalance is false only for LOSS', () => {
    for (const kind of ALL_KINDS) {
      expect(ofKind(kind).affectsBalance()).toBe(kind !== Kind.Loss);
    }
  });

  test('matchesPayload', () => {
    const transaction = WagerTransaction.create(props({ payloadHash: 'abc123' }));

    expect(transaction.matchesPayload('abc123')).toBe(true);
    expect(transaction.matchesPayload('abc124')).toBe(false);
    expect(transaction.matchesPayload('ABC123')).toBe(false);
    expect(transaction.matchesPayload('')).toBe(false);
  });

  test('ledgerDirectionFor: BET debits; WIN, REFUND and OPENING credit', () => {
    expect(ofKind(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(ofKind(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(ofKind(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(ofKind(Kind.Opening).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    // The direction of these kinds does not depend on the reference.
    const winOfBet = WagerTransaction.create(
      props({ kind: Kind.Win, referenceExternalTransactionId: 'transaction-100' }),
    );
    expect(ofKind(Kind.Refund).ledgerDirectionFor(referenced(Kind.Bet))).toBe(
      LedgerDirection.Credit,
    );
    expect(winOfBet.ledgerDirectionFor(referenced(Kind.Bet))).toBe(LedgerDirection.Credit);
  });

  test('ledgerDirectionFor: ROLLBACK inverts its reference', () => {
    const rollback = ofKind(Kind.Rollback);

    expect(rollback.ledgerDirectionFor(referenced(Kind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(referenced(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(referenced(Kind.Refund))).toBe(LedgerDirection.Debit);

    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionError);
    for (const kind of [Kind.Loss, Kind.Rollback, Kind.Opening]) {
      expect(() => rollback.ledgerDirectionFor(referenced(kind))).toThrow(/can only invert/);
    }
  });

  test('ledgerDirectionFor: refuses a transaction that is not the declared reference', () => {
    // The wrong reference would silently invert the direction of the money.
    const rollback = ofKind(Kind.Rollback);
    const strangers = [
      referenced(Kind.Win, { externalTransactionId: 'transaction-999' }),
      referenced(Kind.Win, { providerId: 'provider-b' }),
    ];

    for (const stranger of strangers) {
      expect(() => rollback.ledgerDirectionFor(stranger)).toThrow(InvalidTransactionError);
      expect(() => rollback.ledgerDirectionFor(stranger)).toThrow(/declared reference/);
      expect(() => ofKind(Kind.Refund).ledgerDirectionFor(stranger)).toThrow(/declared reference/);
    }
    // A transaction that declares no reference cannot be given one.
    expect(() => ofKind(Kind.Bet).ledgerDirectionFor(referenced(Kind.Bet))).toThrow(
      /declared reference/,
    );
  });

  test('counterparty: OPENING posts against FUNDING', () => {
    expect(ofKind(Kind.Opening).counterparty()).toEqual({ kind: LedgerAccountKind.Funding });
  });

  test('counterparty: BET, WIN, REFUND and ROLLBACK post against the settlement account of their provider', () => {
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback]) {
      expect(ofKind(kind).counterparty()).toEqual({
        kind: LedgerAccountKind.ProviderSettlement,
        providerId: 'provider-a',
      });
    }
  });

  test('counterparty: LOSS has none', () => {
    expect(() => ofKind(Kind.Loss).counterparty()).toThrow(InvalidTransactionError);
    expect(() => ofKind(Kind.Loss).counterparty()).toThrow(/does not move the balance/);
  });

  test('ledgerDirectionFor: LOSS has none', () => {
    const lossOfBet = WagerTransaction.create(
      props({ kind: Kind.Loss, referenceExternalTransactionId: 'transaction-100' }),
    );

    expect(() => ofKind(Kind.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionError);
    expect(() => lossOfBet.ledgerDirectionFor(referenced(Kind.Bet))).toThrow(
      /does not move the balance/,
    );
  });
});

/** `transaction` moved to `PROCESSED`, resolving its own reference when it declares one. */
function processed(transaction: WagerTransaction): WagerTransaction {
  const resolved = transaction.referenceExternalTransactionId === undefined ? undefined : 'tx-050';
  transaction.markProcessed(resolved, BALANCE, PROCESSED_AT);
  return transaction;
}

describe('WagerTransaction reference rules (statement §7)', () => {
  test('referenceFailure: undefined when every rule holds, for each allowed pair', () => {
    const allowed: [Kind, Kind][] = [
      [Kind.Refund, Kind.Bet],
      [Kind.Rollback, Kind.Bet],
      [Kind.Rollback, Kind.Win],
      [Kind.Rollback, Kind.Refund],
      [Kind.Win, Kind.Bet],
      [Kind.Loss, Kind.Bet],
    ];
    for (const [kind, referenceKind] of allowed) {
      const transaction = WagerTransaction.create(
        props({ kind, referenceExternalTransactionId: 'transaction-100' }),
      );
      expect(transaction.referenceFailure(processed(referenced(referenceKind)), false)).toBe(
        undefined,
      );
    }
  });

  test('referenceFailure: REFERENCE_MISMATCH for another player, wallet, currency or round', () => {
    const strangers = [
      referenced(Kind.Bet, { playerId: 'player-2' }),
      referenced(Kind.Bet, { walletId: 'wallet-2' }),
      referenced(Kind.Bet, { money: Money.from({ amount: '25.00', currency: 'USD' }) }),
      referenced(Kind.Bet, { roundId: 'round-988' }),
    ];
    for (const stranger of strangers) {
      expect(ofKind(Kind.Refund).referenceFailure(processed(stranger), false)).toBe(
        FailureCode.ReferenceMismatch,
      );
    }
  });

  test('referenceFailure: REFERENCE_KIND_NOT_ALLOWED outside the allowed pairs', () => {
    const forbidden: [Kind, Kind][] = [
      [Kind.Refund, Kind.Win],
      [Kind.Refund, Kind.Refund],
      [Kind.Refund, Kind.Loss],
      [Kind.Refund, Kind.Rollback],
      [Kind.Rollback, Kind.Loss],
      [Kind.Rollback, Kind.Rollback],
      [Kind.Win, Kind.Win],
      [Kind.Loss, Kind.Refund],
    ];
    for (const [kind, referenceKind] of forbidden) {
      const transaction = WagerTransaction.create(
        props({ kind, referenceExternalTransactionId: 'transaction-100' }),
      );
      expect(transaction.referenceFailure(processed(referenced(referenceKind)), false)).toBe(
        FailureCode.ReferenceKindNotAllowed,
      );
    }
  });

  test('referenceFailure: REFERENCE_NOT_PROCESSED for a REJECTED or FAILED reference; a waiting one breaks no rule', () => {
    const rejected = referenced(Kind.Bet);
    rejected.reject(FailureCode.InsufficientFunds, BALANCE);
    const failed = referenced(Kind.Bet);
    failed.fail(FailureCode.ProcessingFailed);
    const waiting = referenced(Kind.Refund);
    waiting.markPendingReference(BALANCE);

    expect(ofKind(Kind.Refund).referenceFailure(rejected, false)).toBe(
      FailureCode.ReferenceNotProcessed,
    );
    expect(ofKind(Kind.Rollback).referenceFailure(failed, false)).toBe(
      FailureCode.ReferenceNotProcessed,
    );
    // L-10: the caller keeps waiting while the reference itself waits.
    expect(ofKind(Kind.Rollback).referenceFailure(waiting, false)).toBe(undefined);
  });

  test('referenceFailure: REFERENCE_AMOUNT_MISMATCH for a reversal only', () => {
    const bigBet = processed(referenced(Kind.Bet, { money: brl('30.00') }));

    expect(ofKind(Kind.Refund).referenceFailure(bigBet, false)).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
    expect(ofKind(Kind.Rollback).referenceFailure(bigBet, false)).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
    const win = WagerTransaction.create(
      props({ kind: Kind.Win, referenceExternalTransactionId: 'transaction-100' }),
    );
    expect(win.referenceFailure(bigBet, false)).toBe(undefined);
  });

  test('referenceFailure: REFERENCE_ALREADY_REVERSED for a reversal only (L-01, L-09)', () => {
    const bet = processed(referenced(Kind.Bet));

    expect(ofKind(Kind.Refund).referenceFailure(bet, true)).toBe(
      FailureCode.ReferenceAlreadyReversed,
    );
    expect(ofKind(Kind.Rollback).referenceFailure(bet, true)).toBe(
      FailureCode.ReferenceAlreadyReversed,
    );
    // A WIN of a refunded BET is accepted: documented limitation (docs/tasks/S6.md, Q2).
    const win = WagerTransaction.create(
      props({ kind: Kind.Win, referenceExternalTransactionId: 'transaction-100' }),
    );
    expect(win.referenceFailure(bet, true)).toBe(undefined);
  });

  test('referenceFailure: the rules apply in order, ownership first', () => {
    // Another round, a WIN, rejected, another amount and already reversed: ownership wins.
    const everythingWrong = referenced(Kind.Win, { roundId: 'round-988', money: brl('30.00') });
    everythingWrong.reject(FailureCode.InsufficientFunds, BALANCE);
    expect(ofKind(Kind.Refund).referenceFailure(everythingWrong, true)).toBe(
      FailureCode.ReferenceMismatch,
    );

    const wrongKind = referenced(Kind.Win, { money: brl('30.00') });
    wrongKind.reject(FailureCode.InsufficientFunds, BALANCE);
    expect(ofKind(Kind.Refund).referenceFailure(wrongKind, true)).toBe(
      FailureCode.ReferenceKindNotAllowed,
    );

    const notProcessed = referenced(Kind.Bet, { money: brl('30.00') });
    notProcessed.reject(FailureCode.InsufficientFunds, BALANCE);
    expect(ofKind(Kind.Refund).referenceFailure(notProcessed, true)).toBe(
      FailureCode.ReferenceNotProcessed,
    );

    const otherAmount = processed(referenced(Kind.Bet, { money: brl('30.00') }));
    expect(ofKind(Kind.Refund).referenceFailure(otherAmount, true)).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
  });

  test('referenceFailure: refuses a transaction that is not the declared reference', () => {
    const stranger = processed(referenced(Kind.Bet, { externalTransactionId: 'transaction-999' }));

    expect(() => ofKind(Kind.Refund).referenceFailure(stranger, false)).toThrow(
      /declared reference/,
    );
    expect(() => ofKind(Kind.Bet).referenceFailure(processed(referenced(Kind.Bet)), false)).toThrow(
      /declared reference/,
    );
  });
});

describe('WagerTransaction state machine', () => {
  test('allows exactly the transitions of ARCHITECTURE §5', () => {
    const allowed: Record<Status, Status[]> = {
      [Status.Pending]: [Status.Processed, Status.Rejected, Status.PendingReference, Status.Failed],
      [Status.PendingReference]: [Status.Processed, Status.Rejected, Status.Failed],
      [Status.Processed]: [],
      [Status.Rejected]: [],
      [Status.Failed]: [],
    };
    const targets = Object.keys(TRANSITIONS) as Status[];
    expect([...targets].sort()).toEqual(ALL_STATUSES.filter((s) => s !== Status.Pending).sort());

    for (const from of ALL_STATUSES) {
      for (const to of targets) {
        const transaction = inStatus(from);
        const transition = () => TRANSITIONS[to]?.(transaction);

        if (allowed[from].includes(to)) {
          transition();
          expect(transaction.status).toBe(to);
        } else {
          expect(transition).toThrow(InvalidTransactionStateError);
          expect(transaction.status).toBe(from);
        }
      }
    }
  });

  test('PROCESSED, REJECTED and FAILED are terminal', () => {
    for (const status of ALL_STATUSES) {
      const terminal = [Status.Processed, Status.Rejected, Status.Failed].includes(status);
      expect(inStatus(status).isTerminal()).toBe(terminal);
    }
  });

  test('markProcessed records the reference, the observed balance and the time', () => {
    const refund = ofKind(Kind.Refund);

    refund.markProcessed('tx-ref', BALANCE, PROCESSED_AT);

    expect(snapshot(refund)).toEqual({
      status: Status.Processed,
      referenceTransactionId: 'tx-ref',
      failureCode: undefined,
      observedBalance: '975.00',
      processedAt: PROCESSED_AT,
    });

    const bet = ofKind(Kind.Bet);
    bet.markProcessed(undefined, BALANCE, PROCESSED_AT);
    expect(bet.status).toBe(Status.Processed);
    expect(bet.referenceTransactionId).toBeUndefined();
  });

  test('markProcessed requires a resolved reference exactly when one was declared', () => {
    const refund = ofKind(Kind.Refund);
    expect(() => refund.markProcessed(undefined, BALANCE, PROCESSED_AT)).toThrow(
      InvalidTransactionStateError,
    );
    expect(refund.status).toBe(Status.Pending);

    const bet = ofKind(Kind.Bet);
    expect(() => bet.markProcessed('tx-ref', BALANCE, PROCESSED_AT)).toThrow(
      InvalidTransactionStateError,
    );
    expect(bet.status).toBe(Status.Pending);

    const winWithReference = WagerTransaction.create(
      props({ kind: Kind.Win, referenceExternalTransactionId: 'transaction-100' }),
    );
    expect(() => winWithReference.markProcessed(undefined, BALANCE, PROCESSED_AT)).toThrow(
      InvalidTransactionStateError,
    );
    winWithReference.markProcessed('tx-ref', BALANCE, PROCESSED_AT);
    expect(winWithReference.referenceTransactionId).toBe('tx-ref');
  });

  test('reject and fail record the failure code', () => {
    const rejected = ofKind(Kind.Bet);
    rejected.reject(FailureCode.InsufficientFunds, brl('20.00'));

    expect(snapshot(rejected)).toEqual({
      status: Status.Rejected,
      referenceTransactionId: undefined,
      failureCode: FailureCode.InsufficientFunds,
      observedBalance: '20.00',
      processedAt: undefined,
    });

    const failed = ofKind(Kind.Bet);
    failed.fail(FailureCode.ProcessingFailed);

    expect(snapshot(failed)).toEqual({
      status: Status.Failed,
      referenceTransactionId: undefined,
      failureCode: FailureCode.ProcessingFailed,
      observedBalance: undefined,
      processedAt: undefined,
    });
  });

  test('reject takes only business codes and fail takes only PROCESSING_FAILED', () => {
    // ARCHITECTURE §6 pairs each code with one status; the provider decides by the pair.
    const businessCodes = Object.values(FailureCode).filter(
      (code) => code !== FailureCode.ProcessingFailed,
    );
    expect(businessCodes.length).toBe(11);

    for (const code of businessCodes) {
      const rejected = ofKind(Kind.Bet);
      rejected.reject(code, BALANCE);
      expect(rejected.failureCode).toBe(code);

      const notFailed = ofKind(Kind.Bet);
      expect(() => notFailed.fail(code)).toThrow(InvalidTransactionStateError);
      expect(snapshot(notFailed).status).toBe(Status.Pending);
      expect(notFailed.failureCode).toBeUndefined();
    }

    const notRejected = ofKind(Kind.Bet);
    expect(() => notRejected.reject(FailureCode.ProcessingFailed, BALANCE)).toThrow(
      InvalidTransactionStateError,
    );
    expect(notRejected.status).toBe(Status.Pending);
    expect(notRejected.failureCode).toBeUndefined();
    expect(notRejected.observedBalance).toBeUndefined();
  });

  test('markPendingReference needs a declared reference', () => {
    const refund = ofKind(Kind.Refund);
    refund.markPendingReference(BALANCE);

    expect(snapshot(refund)).toEqual({
      status: Status.PendingReference,
      referenceTransactionId: undefined,
      failureCode: undefined,
      observedBalance: '975.00',
      processedAt: undefined,
    });

    const bet = ofKind(Kind.Bet);
    expect(() => bet.markPendingReference(BALANCE)).toThrow(InvalidTransactionStateError);
    expect(bet.status).toBe(Status.Pending);
  });

  test('a pending reference can be processed or rejected later, with the balance seen then', () => {
    const applied = ofKind(Kind.Refund);
    applied.markPendingReference(brl('70.00'));
    applied.markProcessed('tx-ref', brl('100.00'), PROCESSED_AT);
    expect(snapshot(applied)).toEqual({
      status: Status.Processed,
      referenceTransactionId: 'tx-ref',
      failureCode: undefined,
      observedBalance: '100.00',
      processedAt: PROCESSED_AT,
    });

    const exhausted = ofKind(Kind.Rollback);
    exhausted.markPendingReference(brl('70.00'));
    exhausted.reject(FailureCode.ReferenceNotFound, brl('55.00'));
    expect(exhausted.status).toBe(Status.Rejected);
    expect(exhausted.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(exhausted.observedBalance?.amount).toBe('55.00');
  });

  test('a failed transition changes nothing', () => {
    const transaction = ofKind(Kind.Refund);
    transaction.markProcessed('tx-ref', BALANCE, PROCESSED_AT);
    const before = snapshot(transaction);

    expect(() =>
      transaction.markProcessed('tx-other', brl('1.00'), new Date('2030-01-01T00:00:00.000Z')),
    ).toThrow(InvalidTransactionStateError);
    expect(() => transaction.markPendingReference(brl('1.00'))).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => transaction.reject(FailureCode.InsufficientFunds, brl('1.00'))).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => transaction.fail(FailureCode.ProcessingFailed)).toThrow(
      InvalidTransactionStateError,
    );

    expect(snapshot(transaction)).toEqual(before);
  });

  test('rehydrate restores any state without validating', () => {
    // A state `create` and the transitions would never produce.
    const transaction = WagerTransaction.rehydrate({
      ...props({ kind: Kind.Refund, money: Money.zero('BRL') }),
      referenceExternalTransactionId: undefined,
      status: Status.Processed,
      referenceTransactionId: 'tx-ref',
      failureCode: FailureCode.ProcessingFailed,
      observedBalance: brl('12.34'),
      processedAt: PROCESSED_AT,
    });

    expect(transaction.kind).toBe(Kind.Refund);
    expect(transaction.money.isZero()).toBe(true);
    expect(transaction.referenceExternalTransactionId).toBeUndefined();
    expect(snapshot(transaction)).toEqual({
      status: Status.Processed,
      referenceTransactionId: 'tx-ref',
      failureCode: FailureCode.ProcessingFailed,
      observedBalance: '12.34',
      processedAt: PROCESSED_AT,
    });
  });
});
