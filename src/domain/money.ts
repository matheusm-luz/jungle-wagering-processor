import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError, MoneyOutOfRangeError } from './errors';

/** Wire and storage shape of an amount: a decimal string with two places and an ISO-4217 code. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;

/**
 * An ISO-4217 code by shape: three uppercase letters (L-16). There is no list of currencies, so the
 * model is multi-currency; every one of them is handled at a scale of two, which is a documented
 * limitation for currencies with another minor unit (JPY, KWD).
 */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * An isolated decimal.js constructor. The library default of 20 significant digits would round a
 * sum of two NUMERIC(19,2) values silently; 40 digits keeps every operation here exact (ADR-02).
 */
const Exact = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** Largest value of a NUMERIC(19,2) column: 17 integer digits and two decimals. */
const MAX = new Exact('99999999999999999.99');

/**
 * Input contract (L-02): digits, a dot and exactly two decimals. No sign, no exponent, no
 * whitespace, no leading zeros, at most 17 integer digits. One amount has one spelling.
 */
const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,16})\.\d{2}$/;

/**
 * An amount of money in one currency. Immutable: every operation returns a new instance.
 * The value is never a `number` at any point; it enters and leaves as a decimal string.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Builds a `Money` from an input contract or from persistence. Negative amounts are refused
   * here; a negative `Money` can only be the result of `subtract` or `negate`.
   */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    Money.assertCurrencyCode(currency);
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Amount must be a decimal string');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'Amount must be a non-negative decimal string with exactly two decimals',
      );
    }

    return new Money(new Exact(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrencyCode(currency);
    return new Money(new Exact(0), currency);
  }

  /** Decimal string with exactly two decimals, such as `"25.00"`. */
  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return this.derive(this.value.plus(other.value));
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return this.derive(this.value.minus(other.value));
  }

  negate(): Money {
    return this.derive(this.value.negated());
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Value equality. Amounts in different currencies are simply not equal; this never throws. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  /** Result of an operation: same currency, still inside the range the database can store. */
  private derive(value: Decimal): Money {
    if (value.abs().greaterThan(MAX)) {
      throw new MoneyOutOfRangeError();
    }
    // decimal.js keeps a signed zero, which would serialise as "-0.00".
    return new Money(value.isZero() ? new Exact(0) : value, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrencyCode(currency: unknown): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Currency must be an ISO-4217 code: three uppercase letters');
    }
  }
}
