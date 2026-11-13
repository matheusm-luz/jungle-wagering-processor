import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  /** Carries the wallet currency. */
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  /** Zero or positive. Its currency becomes the wallet currency. */
  initialBalance: Money;
  /** Ids of the internal `OPENING` transaction and of its entry; unused when the balance is zero. */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

/** One debit or credit. Ids and time come from the caller, so the domain needs no port. */
export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root of a player's balance in one currency.
 *
 * The balance can only change through `debit` and `credit`, and each of them returns the ledger
 * entry it produced: inside the aggregate there is no balance change without an entry and no entry
 * without a balance change. Guarding against concurrent writers is not done here; the use case
 * loads the wallet under a row lock (ADR-01).
 */
export class Wallet {
  /** Instants are kept as epoch milliseconds, so a `Date` handed out cannot change the wallet. */
  private readonly createdAtMs: number;
  private updatedAtMs: number;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.createdAtMs = createdAt.getTime();
    this.updatedAtMs = updatedAt.getTime();
  }

  /**
   * Opens a wallet at version 1. A positive opening balance is itself a movement, so it comes with
   * its `CREDIT` entry (from zero, sequence 1); a zero balance moves nothing and has no entry.
   */
  static open(props: OpenWalletProps): {
    wallet: Wallet;
    openingEntry: WalletLedgerEntry | undefined;
  } {
    const { initialBalance } = props;

    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('A wallet cannot be opened with a negative balance');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      props.at,
      props.at,
    );

    const openingEntry = initialBalance.isZero()
      ? undefined
      : WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: wallet.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
          sequence: wallet.version,
          createdAt: props.at,
        });

    return { wallet, openingEntry };
  }

  /** Rebuilds a persisted wallet. Validates nothing. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.balance.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  get balance(): Money {
    return this._balance;
  }

  /** Starts at 1 and increments only when the balance changes. */
  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtMs);
  }

  /** Throws `InsufficientFundsError` when the amount exceeds the balance; nothing changes then. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, movement);
  }

  /**
   * Throws `MoneyOutOfRangeError` when the new balance would not fit the storable range; nothing
   * changes then. The request was valid, so the caller must not treat it as a malformed amount.
   */
  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, movement);
  }

  /** Every guard, and the entry itself, come before the first assignment: a failure changes nothing. */
  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    const { money } = movement;

    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError('A wallet movement must be a positive amount');
    }
    if (direction === LedgerDirection.Debit && this._balance.isLessThan(money)) {
      throw new InsufficientFundsError();
    }

    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(money)
        : balanceBefore.add(money);
    const version = this._version + 1;

    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      sequence: version,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version = version;
    this.updatedAtMs = movement.at.getTime();

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
