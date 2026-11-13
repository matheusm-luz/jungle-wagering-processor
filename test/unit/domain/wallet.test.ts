import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidWalletOperationError,
  MoneyOutOfRangeError,
} from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const OPENED_AT = new Date('2026-11-13T01:00:00.000Z');
const LATER = new Date('2026-11-13T02:00:00.000Z');

function open(initialBalance: Money) {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance,
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    at: OPENED_AT,
  });
}

function walletWith(amount: string): Wallet {
  return open(brl(amount)).wallet;
}

function snapshot(wallet: Wallet) {
  return {
    balance: wallet.balance.amount,
    version: wallet.version,
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

describe('Wallet opening', () => {
  test('opens at version 1 with one CREDIT entry from zero when the balance is positive', () => {
    const { wallet, openingEntry } = open(brl('1000.00'));

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(OPENED_AT);
    expect(wallet.updatedAt).toEqual(OPENED_AT);

    expect(openingEntry).toBeDefined();
    expect(openingEntry?.id).toBe('entry-opening');
    expect(openingEntry?.walletId).toBe('wallet-1');
    expect(openingEntry?.transactionId).toBe('tx-opening');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.money.amount).toBe('1000.00');
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
    expect(openingEntry?.sequence).toBe(1);
    expect(openingEntry?.createdAt).toEqual(OPENED_AT);
  });

  test('opens at version 1 with no entry when the balance is zero', () => {
    const { wallet, openingEntry } = open(Money.zero('USD'));

    expect(openingEntry).toBeUndefined();
    expect(wallet.balance.amount).toBe('0.00');
    expect(wallet.currency).toBe('USD');
    expect(wallet.version).toBe(1);
  });

  test('rejects a negative opening balance', () => {
    expect(() => open(brl('10.00').negate())).toThrow(InvalidWalletOperationError);
  });

  test('rehydrate restores state without validating', () => {
    // A state `open` would never produce: rehydration trusts what the database already accepted.
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      balance: brl('5.00').negate(),
      version: 42,
      createdAt: OPENED_AT,
      updatedAt: LATER,
    });

    expect(wallet.id).toBe('wallet-9');
    expect(wallet.playerId).toBe('player-9');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.amount).toBe('-5.00');
    expect(wallet.version).toBe(42);
    expect(wallet.createdAt).toEqual(OPENED_AT);
    expect(wallet.updatedAt).toEqual(LATER);
  });
});

describe('Wallet movements', () => {
  test('credit raises the balance, increments the version and returns the matching entry', () => {
    const wallet = walletWith('100.00');

    const entry = wallet.credit({
      entryId: 'entry-2',
      transactionId: 'tx-2',
      money: brl('50.50'),
      at: LATER,
    });

    expect(snapshot(wallet)).toEqual({
      balance: '150.50',
      version: 2,
      updatedAt: LATER.toISOString(),
    });
    expect(wallet.createdAt).toEqual(OPENED_AT);

    expect(entry.id).toBe('entry-2');
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-2');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.money.amount).toBe('50.50');
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('150.50');
    expect(entry.sequence).toBe(2);
    expect(entry.createdAt).toEqual(LATER);
    expect(entry.isBalanced()).toBe(true);
  });

  test('debit lowers the balance, increments the version and returns the matching entry', () => {
    const wallet = walletWith('100.00');

    const entry = wallet.debit({
      entryId: 'entry-2',
      transactionId: 'tx-2',
      money: brl('80.00'),
      at: LATER,
    });

    expect(snapshot(wallet)).toEqual({
      balance: '20.00',
      version: 2,
      updatedAt: LATER.toISOString(),
    });

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.amount).toBe('80.00');
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('20.00');
    expect(entry.sequence).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('debit of the whole balance leaves zero', () => {
    const wallet = walletWith('100.00');

    const entry = wallet.debit({
      entryId: 'entry-2',
      transactionId: 'tx-2',
      money: brl('100.00'),
      at: LATER,
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(entry.balanceAfter.amount).toBe('0.00');
  });

  test('debit above the balance throws InsufficientFundsError and changes nothing', () => {
    // The mandatory scenario of statement §8, seen from inside the aggregate.
    const wallet = walletWith('100.00');
    wallet.debit({ entryId: 'entry-2', transactionId: 'tx-2', money: brl('80.00'), at: LATER });
    const before = snapshot(wallet);

    expect(() =>
      wallet.debit({
        entryId: 'entry-3',
        transactionId: 'tx-3',
        money: brl('80.00'),
        at: new Date('2026-11-13T03:00:00.000Z'),
      }),
    ).toThrow(InsufficientFundsError);

    expect(snapshot(wallet)).toEqual(before);
    expect(before).toEqual({ balance: '20.00', version: 2, updatedAt: LATER.toISOString() });

    const empty = walletWith('0.00');
    expect(() =>
      empty.debit({ entryId: 'entry-2', transactionId: 'tx-2', money: brl('0.01'), at: LATER }),
    ).toThrow(InsufficientFundsError);
  });

  test('a movement in another currency throws CurrencyMismatchError and changes nothing', () => {
    const wallet = walletWith('100.00');
    const before = snapshot(wallet);
    const movement = { entryId: 'entry-2', transactionId: 'tx-2', money: usd('10.00'), at: LATER };

    expect(() => wallet.debit(movement)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement)).toThrow(CurrencyMismatchError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test('a credit beyond the storable range throws MoneyOutOfRangeError and changes nothing', () => {
    // Reachable with valid input: two maximum credits. It must not look like a malformed amount.
    const wallet = walletWith('99999999999999999.99');
    const before = snapshot(wallet);

    const credit = () =>
      wallet.credit({ entryId: 'entry-2', transactionId: 'tx-2', money: brl('0.01'), at: LATER });

    expect(credit).toThrow(MoneyOutOfRangeError);
    expect(credit).not.toThrow(InvalidMoneyError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test('exposes dates that cannot be used to change it', () => {
    const wallet = walletWith('100.00');
    wallet.credit({ entryId: 'entry-2', transactionId: 'tx-2', money: brl('1.00'), at: LATER });

    wallet.createdAt.setFullYear(1999);
    wallet.updatedAt.setFullYear(1999);

    expect(wallet.createdAt).toEqual(OPENED_AT);
    expect(wallet.updatedAt).toEqual(LATER);
  });

  test('a zero or negative movement is refused and changes nothing', () => {
    const wallet = walletWith('100.00');
    const before = snapshot(wallet);

    for (const money of [brl('0.00'), brl('10.00').negate()]) {
      const movement = { entryId: 'entry-2', transactionId: 'tx-2', money, at: LATER };

      expect(() => wallet.debit(movement)).toThrow(InvalidWalletOperationError);
      expect(() => wallet.credit(movement)).toThrow(InvalidWalletOperationError);
    }
    expect(snapshot(wallet)).toEqual(before);
  });

  test('the balance always equals the balance rebuilt from the returned entries', () => {
    const { wallet, openingEntry } = open(brl('100.00'));
    const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];

    const steps: Array<['debit' | 'credit', string]> = [
      ['debit', '30.00'],
      ['credit', '0.01'],
      ['debit', '999.00'], // refused: no entry, no change
      ['debit', '70.01'],
      ['credit', '250.00'],
      ['debit', '0.00'], // refused: no entry, no change
      ['debit', '125.50'],
    ];

    steps.forEach(([operation, amount], index) => {
      try {
        entries.push(
          wallet[operation]({
            entryId: `entry-${index}`,
            transactionId: `tx-${index}`,
            money: brl(amount),
            at: LATER,
          }),
        );
      } catch (error) {
        if (
          !(error instanceof InsufficientFundsError) &&
          !(error instanceof InvalidWalletOperationError)
        ) {
          throw error;
        }
      }
    });

    const rebuilt = entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit
          ? balance.add(entry.money)
          : balance.subtract(entry.money),
      Money.zero('BRL'),
    );

    expect(wallet.balance.amount).toBe('124.50');
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    // One entry per balance change: versions and sequences advance together, with no gap.
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(wallet.version).toBe(6);
    expect(entries.at(-1)?.balanceAfter.equals(wallet.balance)).toBe(true);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]?.balanceBefore.equals(entries[i - 1]?.balanceAfter as Money)).toBe(true);
    }
  });
});
