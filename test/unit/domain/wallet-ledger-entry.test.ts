import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidLedgerEntryError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import {
  type CreateLedgerEntryProps,
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const AT = new Date('2026-11-13T01:00:00.000Z');

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('80.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('20.00'),
    sequence: 2,
    createdAt: AT,
    ...overrides,
  };
}

describe('WalletLedgerEntry', () => {
  test('creates a balanced debit and a balanced credit', () => {
    const debit = WalletLedgerEntry.create(props());

    expect(debit.isBalanced()).toBe(true);
    expect(debit.id).toBe('entry-1');
    expect(debit.walletId).toBe('wallet-1');
    expect(debit.transactionId).toBe('tx-1');
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.money.amount).toBe('80.00');
    expect(debit.balanceBefore.amount).toBe('100.00');
    expect(debit.balanceAfter.amount).toBe('20.00');
    expect(debit.sequence).toBe(2);
    expect(debit.createdAt).toEqual(AT);

    const credit = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('180.00') }),
    );

    expect(credit.isBalanced()).toBe(true);
    expect(credit.balanceAfter.amount).toBe('180.00');
  });

  test('rejects broken arithmetic', () => {
    const broken: Partial<CreateLedgerEntryProps>[] = [
      { balanceAfter: brl('20.01') },
      { balanceAfter: brl('180.00') }, // a debit recorded with the result of a credit
      { direction: LedgerDirection.Credit }, // a credit recorded with the result of a debit
      { balanceAfter: brl('100.00') }, // the balance did not move
    ];

    for (const overrides of broken) {
      expect(() => WalletLedgerEntry.create(props(overrides))).toThrow(InvalidLedgerEntryError);
    }
  });

  test('rejects a zero or negative amount', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('0.00'), balanceAfter: brl('100.00') })),
    ).toThrow(InvalidLedgerEntryError);

    expect(() =>
      WalletLedgerEntry.create(
        props({ money: brl('80.00').negate(), balanceAfter: brl('180.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a negative balance before or after', () => {
    // 20.00 - 80.00 = -60.00: the arithmetic holds, the balance does not.
    expect(() =>
      WalletLedgerEntry.create(
        props({ balanceBefore: brl('20.00'), balanceAfter: brl('20.00').subtract(brl('80.00')) }),
      ),
    ).toThrow(InvalidLedgerEntryError);

    expect(() =>
      WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Credit,
          balanceBefore: brl('100.00').negate(),
          balanceAfter: brl('20.00').negate(),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects mixed currencies', () => {
    expect(() => WalletLedgerEntry.create(props({ money: usd('80.00') }))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => WalletLedgerEntry.create(props({ balanceBefore: usd('100.00') }))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: usd('20.00') }))).toThrow(
      CurrencyMismatchError,
    );
  });

  test('rejects a sequence below 1', () => {
    for (const sequence of [0, -1, 1.5, Number.NaN]) {
      expect(() => WalletLedgerEntry.create(props({ sequence }))).toThrow(InvalidLedgerEntryError);
    }
  });

  test('is frozen', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('999.00');
    }).toThrow(TypeError);
    expect(entry.balanceAfter.amount).toBe('20.00');
  });

  test('copies the date it is given and exposes one that cannot change it', () => {
    const createdAt = new Date(AT);
    const entry = WalletLedgerEntry.create(props({ createdAt }));

    createdAt.setFullYear(1999);
    expect(entry.createdAt).toEqual(AT);

    // Object.freeze does not reach inside a Date, so the entry must not hand out its own.
    entry.createdAt.setFullYear(1999);
    expect(entry.createdAt).toEqual(AT);
  });

  test('rehydrate rebuilds without validating', () => {
    // A row that `create` would refuse: rehydration trusts what the database already accepted.
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('999.00') }));

    expect(entry.balanceAfter.amount).toBe('999.00');
    expect(entry.isBalanced()).toBe(false);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
