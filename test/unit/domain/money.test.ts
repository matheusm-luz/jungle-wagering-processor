import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  MoneyOutOfRangeError,
} from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money creation', () => {
  test('accepts a decimal string with exactly two decimals', () => {
    for (const amount of ['0.00', '0.01', '25.00', '1000.50', '99999999999999999.99']) {
      expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
    }
  });

  test('rejects NaN, Infinity, scientific notation, empty string and malformed input', () => {
    const invalid = [
      'NaN',
      'Infinity',
      '-Infinity',
      '1e2',
      '1E2',
      '1.00e2',
      '',
      ' ',
      ' 25.00',
      '25.00 ',
      '25,00',
      '1,000.00',
      '+25.00',
      '.50',
      '25.',
      '0x10.00',
      '25.0a',
      'abc',
      '00.50',
      '025.00',
      '25.00\n',
    ];

    for (const amount of invalid) {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    }
  });

  test('rejects fewer or more than two decimals', () => {
    for (const amount of ['25', '25.5', '25.000', '25.001', '0.999']) {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    }
  });

  test('rejects a negative amount on input', () => {
    for (const amount of ['-0.01', '-25.00', '-0.00']) {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    }
  });

  test('rejects an amount that is not a string', () => {
    for (const amount of [25, 25.5, null, undefined, {}, ['25.00'], true]) {
      expect(() => Money.from({ amount: amount as unknown as string, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    }
  });

  test('rejects an amount beyond NUMERIC(19,2)', () => {
    expect(() => brl('100000000000000000.00')).toThrow(InvalidMoneyError);
  });

  test('accepts any ISO-4217 shaped currency code', () => {
    // L-16: the code is validated by shape only; every currency is handled at a scale of two.
    for (const currency of ['BRL', 'USD', 'EUR', 'JPY', 'XXX']) {
      expect(Money.from({ amount: '1.00', currency }).toJSON()).toEqual({
        amount: '1.00',
        currency,
      });
      expect(Money.zero(currency).toJSON()).toEqual({ amount: '0.00', currency });
    }
  });

  test('rejects a malformed currency', () => {
    for (const currency of ['', 'brl', 'Brl', 'BR', 'BRLL', 'R$', 'B1L', ' BRL', 'BRL ', 'BRL\n']) {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
      expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
    }
    for (const currency of [986, null, undefined, ['BRL']]) {
      expect(() => Money.from({ amount: '1.00', currency: currency as unknown as string })).toThrow(
        InvalidMoneyError,
      );
    }
  });

  test('never echoes the rejected amount in the error', () => {
    try {
      brl('1234567.891');
      throw new Error('expected Money.from to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect((error as Error).message).not.toContain('1234567');
    }
  });

  test('serialises to MoneyProps with a fixed scale of two', () => {
    const money = brl('25.00');

    expect(money.amount).toBe('25.00');
    expect(money.currency).toBe('BRL');
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(JSON.stringify({ money })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(money.toString()).toBe('25.00 BRL');
    expect(`${money}`).toBe('25.00 BRL');
    expect(typeof money.toJSON().amount).toBe('string');
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });
});

describe('Money arithmetic', () => {
  test('adds and subtracts without rounding', () => {
    expect(brl('100.00').add(brl('0.01')).amount).toBe('100.01');
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    expect(brl('0.99').add(brl('0.01')).amount).toBe('1.00');
    expect(brl('1.00').subtract(brl('0.01')).amount).toBe('0.99');
    expect(brl('25.00').subtract(brl('25.00')).amount).toBe('0.00');
  });

  test('is exact where binary floating point is not', () => {
    // 0.1 + 0.2 === 0.30000000000000004 and 1.1 + 2.2 === 3.3000000000000003 with `number`.
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('1.10').add(brl('2.20')).amount).toBe('3.30');
    expect(brl('0.30').subtract(brl('0.10')).amount).toBe('0.20');

    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('10.00');
  });

  test('keeps large sums exact', () => {
    // 19 significant digits: beyond Number.MAX_SAFE_INTEGER and near decimal.js's default precision.
    expect(brl('99999999999999999.98').add(brl('0.01')).amount).toBe('99999999999999999.99');
    expect(brl('99999999999999999.99').subtract(brl('0.01')).amount).toBe('99999999999999999.98');
    expect(brl('90071992547409.93').add(brl('90071992547409.93')).amount).toBe(
      '180143985094819.86',
    );
  });

  test('refuses a result beyond NUMERIC(19,2) with its own error', () => {
    const overflow = () => brl('99999999999999999.99').add(brl('0.01'));
    const underflow = () => brl('99999999999999999.99').negate().subtract(brl('0.01'));

    // Not InvalidMoneyError: the operands were valid, so this is not a malformed input.
    for (const operation of [overflow, underflow]) {
      expect(operation).toThrow(MoneyOutOfRangeError);
      expect(operation).not.toThrow(InvalidMoneyError);
    }
  });

  test('subtract may produce a negative value and negate inverts it', () => {
    const negative = brl('10.00').subtract(brl('25.50'));

    expect(negative.amount).toBe('-15.50');
    expect(negative.isNegative()).toBe(true);
    expect(negative.negate().amount).toBe('15.50');
    expect(brl('15.50').negate().amount).toBe('-15.50');
    expect(Money.zero('BRL').negate().amount).toBe('0.00');
  });

  test('isZero, isPositive, isNegative, isLessThan', () => {
    const zero = Money.zero('BRL');
    const one = brl('1.00');
    const minusOne = one.negate();

    expect([zero.isZero(), zero.isPositive(), zero.isNegative()]).toEqual([true, false, false]);
    expect([one.isZero(), one.isPositive(), one.isNegative()]).toEqual([false, true, false]);
    expect([minusOne.isZero(), minusOne.isPositive(), minusOne.isNegative()]).toEqual([
      false,
      false,
      true,
    ]);

    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.01').isLessThan(brl('80.00'))).toBe(false);
    expect(minusOne.isLessThan(zero)).toBe(true);
  });

  test('equals compares amount and currency', () => {
    expect(brl('25.00').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('25.00').equals(usd('25.00'))).toBe(false);
    expect(Money.zero('BRL').equals(brl('0.00'))).toBe(true);
    expect(Money.zero('BRL').negate().equals(Money.zero('BRL'))).toBe(true);
  });

  test('operations across currencies throw CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd('2.00'))).toThrow(CurrencyMismatchError);
    expect(() => Money.zero('BRL').add(Money.zero('USD'))).toThrow(CurrencyMismatchError);
  });

  test('every operation returns a new instance and the operands are unchanged', () => {
    const a = brl('100.00');
    const b = brl('80.00');

    const results = [a.add(b), a.subtract(b), a.negate()];

    for (const result of results) {
      expect(result).toBeInstanceOf(Money);
      expect(result).not.toBe(a);
      expect(result).not.toBe(b);
    }
    expect(a.amount).toBe('100.00');
    expect(b.amount).toBe('80.00');
  });

  test('is frozen', () => {
    const money = brl('100.00');

    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = 'USD';
    }).toThrow(TypeError);
    expect(money.currency).toBe('BRL');
  });
});
