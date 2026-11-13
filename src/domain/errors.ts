/**
 * Base of every error raised by the domain.
 * Outer layers translate these into failure codes and transport status; the domain knows neither.
 */
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input that cannot become a `Money`: bad format, wrong scale, negative, unsupported currency. */
export class InvalidMoneyError extends DomainError {}

/**
 * The result of an operation on two valid amounts does not fit the storable range, for example a
 * credit on a wallet that is already at the maximum. Deliberately not an `InvalidMoneyError`: the
 * request was well-formed, so the outcome depends on state and must not be answered as a bad payload.
 */
export class MoneyOutOfRangeError extends DomainError {
  constructor() {
    super('Amount is outside the supported range');
  }
}

/** Two amounts in different currencies met in one operation. */
export class CurrencyMismatchError extends DomainError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * A debit larger than the balance. The caller picks the failure code: a bet without funds and a
 * reversal that would overdraw are different situations for the provider (statement §7.9).
 */
export class InsufficientFundsError extends DomainError {
  constructor() {
    super('Insufficient funds');
  }
}

/** A wallet operation that is never valid, such as a movement of zero. A programming error. */
export class InvalidWalletOperationError extends DomainError {}

/** A ledger entry whose arithmetic or values are inconsistent. */
export class InvalidLedgerEntryError extends DomainError {}

/** A transaction that cannot be created: reference or amount rule of its kind is violated. */
export class InvalidTransactionError extends DomainError {}

/** A transition that the state machine does not allow. A programming error, not a business path. */
export class InvalidTransactionStateError extends DomainError {}
