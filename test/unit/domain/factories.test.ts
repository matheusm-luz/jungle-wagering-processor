import { describe, expect, test } from 'bun:test';
import type { Money } from '../../../src/domain/money';
import type { OutboxMessage } from '../../../src/domain/outbox-message';
import type { WagerTransaction } from '../../../src/domain/wager-transaction';
import type { Wallet } from '../../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';

/** `true` when `new T(...)` compiles from outside the class, `false` for a private constructor. */
type IsConstructible<T> = T extends abstract new (...args: never[]) => unknown ? true : false;

class PublicControl {
  constructor(readonly value: string) {}
}

describe('domain classes', () => {
  // Proven by `bun run typecheck`: each assignment below stops compiling if the answer changes,
  // so making one of these constructors public breaks the build.
  test('can only be built through their static factories', () => {
    const control: IsConstructible<typeof PublicControl> = true;
    const money: IsConstructible<typeof Money> = false;
    const wallet: IsConstructible<typeof Wallet> = false;
    const transaction: IsConstructible<typeof WagerTransaction> = false;
    const ledgerEntry: IsConstructible<typeof WalletLedgerEntry> = false;
    const outboxMessage: IsConstructible<typeof OutboxMessage> = false;

    expect(new PublicControl('x').value).toBe('x');
    expect({ control, money, wallet, transaction, ledgerEntry, outboxMessage }).toEqual({
      control: true,
      money: false,
      wallet: false,
      transaction: false,
      ledgerEntry: false,
      outboxMessage: false,
    });
  });
});
