import { describe, expect, test } from 'bun:test';
import { reconcile } from '../../../src/application/reconcile-wallet';
import { Money } from '../../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('reconcile (R-49)', () => {
  test('consistent when the stored balance equals credits minus debits', () => {
    const result = reconcile({
      walletId: 'w',
      stored: brl('975.00'),
      credits: brl('1075.00'),
      debits: brl('100.00'),
      entries: 3,
    });

    expect(result).toEqual({
      walletId: 'w',
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test('a stored balance below the ledger gives a negative difference', () => {
    const result = reconcile({
      walletId: 'w',
      stored: brl('900.00'),
      credits: brl('1000.00'),
      debits: brl('25.00'),
      entries: 2,
    });

    expect(result.difference).toEqual({ amount: '-75.00', currency: 'BRL' });
    expect(result.consistent).toBe(false);
  });

  test('a stored balance above the ledger gives a positive difference', () => {
    const result = reconcile({
      walletId: 'w',
      stored: brl('10.00'),
      credits: brl('0.00'),
      debits: brl('0.00'),
      entries: 0,
    });

    expect(result.calculatedBalance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.difference).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(result.consistent).toBe(false);
  });
});
