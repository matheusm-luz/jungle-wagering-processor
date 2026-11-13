import { CurrencyMismatchError, InvalidLedgerEntryError } from './errors';
import type { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** The wallet version this entry produced. Unique per wallet, so a lost update cannot be recorded. */
  sequence: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * One movement of one wallet. Immutable by structure: no setters, no transitions, and the instance
 * is frozen. The ledger is append-only; a correction is a new entry, never a change to this one.
 */
export class WalletLedgerEntry {
  /** Kept as epoch milliseconds: `Object.freeze` does not reach inside a `Date`. */
  private readonly createdAtMs: number;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly sequence: number,
    createdAt: Date,
  ) {
    this.createdAtMs = createdAt.getTime();
    Object.freeze(this);
  }

  /** A fresh `Date` on every read, so no caller can change the entry through it. */
  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  /** Validates the entry: one currency, positive amount, non-negative balances, exact arithmetic. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    const { money, balanceBefore, balanceAfter, sequence } = entry;

    for (const other of [balanceBefore, balanceAfter]) {
      if (other.currency !== money.currency) {
        throw new CurrencyMismatchError(money.currency, other.currency);
      }
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('A ledger entry must move a positive amount');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('A ledger entry cannot record a negative balance');
    }
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new InvalidLedgerEntryError('A ledger entry sequence must be an integer from 1');
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('Ledger entry arithmetic does not hold');
    }

    return entry;
  }

  /** Rebuilds a persisted entry. Validates nothing. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.sequence,
      state.createdAt,
    );
  }

  /** `balanceBefore - money == balanceAfter` for a debit, `balanceBefore + money` for a credit. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expected.equals(this.balanceAfter);
  }
}
