import { describe, expect, test } from 'bun:test';
import { InvalidIntegrationEventError } from '../../../src/domain/errors';
import { IntegrationEvent } from '../../../src/domain/events/integration-event';
import { WagerTransactionProcessed } from '../../../src/domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { Money } from '../../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-11-13T12:00:00.000Z');

function context(eventId = 'event-1') {
  return { eventId, correlationId: 'correlation-1', occurredAt: AT };
}

function openedWallet() {
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('1000.00'),
    openingTransactionId: 'tx-1',
    openingEntryId: 'entry-1',
    at: AT,
  });
  if (openingEntry === undefined) throw new Error('expected an opening entry');
  return { wallet, entry: openingEntry };
}

function betProps(): CreateWagerTransactionProps {
  return {
    id: 'tx-2',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'key-123',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: AT,
  };
}

function bet(): WagerTransaction {
  return WagerTransaction.create(betProps());
}

describe('WalletBalanceChanged', () => {
  test('toJSON is the envelope with an ISO occurredAt and MoneyProps in data', () => {
    const { wallet, entry } = openedWallet();

    const event = WalletBalanceChanged.from(wallet, entry, {
      ...context(),
      causationId: 'message-1',
    });

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'message-1',
      occurredAt: '2026-11-13T12:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'CREDIT',
        money: { amount: '1000.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '1000.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
  });

  test('leaves causationId out of the JSON when there is none', () => {
    const { wallet, entry } = openedWallet();

    const json = WalletBalanceChanged.from(wallet, entry, context()).toJSON();

    expect(Object.keys(json)).not.toContain('causationId');
  });

  test('eventType and version live on the class', () => {
    const { wallet, entry } = openedWallet();
    const event = WalletBalanceChanged.from(wallet, entry, context());

    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
  });

  test('from refuses an entry that is not the last movement of the wallet', () => {
    const { wallet, entry } = openedWallet();
    wallet.credit({ entryId: 'entry-2', transactionId: 'tx-2', money: brl('5.00'), at: AT });
    const other = openedWallet().entry;

    expect(() => WalletBalanceChanged.from(wallet, entry, context())).toThrow(
      InvalidIntegrationEventError,
    );
    const { wallet: stranger } = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-1',
      initialBalance: brl('1000.00'),
      openingTransactionId: 'tx-9',
      openingEntryId: 'entry-9',
      at: AT,
    });
    expect(() => WalletBalanceChanged.from(stranger, other, context())).toThrow(
      InvalidIntegrationEventError,
    );
  });

  test('is immutable', () => {
    const { wallet, entry } = openedWallet();
    const event = WalletBalanceChanged.from(wallet, entry, context());

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    event.occurredAt.setFullYear(2000);
    expect(event.occurredAt.toISOString()).toBe('2026-11-13T12:00:00.000Z');
  });
});

describe('WagerTransactionProcessed', () => {
  test('carries the transaction, the observed balance and the wallet version', () => {
    const { wallet } = openedWallet();
    const transaction = bet();
    wallet.debit({ entryId: 'entry-2', transactionId: 'tx-2', money: brl('25.00'), at: AT });
    transaction.markProcessed(undefined, wallet.balance, AT);

    const event = WagerTransactionProcessed.from(transaction, wallet, context('event-2'));

    expect(event.toJSON()).toEqual({
      eventId: 'event-2',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      occurredAt: '2026-11-13T12:00:00.000Z',
      version: 1,
      data: {
        transactionId: 'tx-2',
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        walletId: 'wallet-1',
        playerId: 'player-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
        balance: { amount: '975.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('includes the reference only when the transaction declares one', () => {
    const { wallet } = openedWallet();
    const win = WagerTransaction.create({
      ...betProps(),
      id: 'tx-3',
      externalTransactionId: 'transaction-124',
      idempotencyKey: 'key-124',
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'transaction-123',
    });
    win.markProcessed('tx-2', wallet.balance, AT);

    const event = WagerTransactionProcessed.from(win, wallet, context());

    expect(event.data.referenceExternalTransactionId).toBe('transaction-123');
    expect(
      Object.keys(WagerTransactionProcessed.from(processedBet(), wallet, context()).data),
    ).not.toContain('referenceExternalTransactionId');
  });

  test('from refuses a transaction that is not PROCESSED or belongs to another wallet', () => {
    const { wallet } = openedWallet();

    expect(() => WagerTransactionProcessed.from(bet(), wallet, context())).toThrow(
      InvalidIntegrationEventError,
    );
    const { wallet: stranger } = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-1',
      initialBalance: brl('1.00'),
      openingTransactionId: 'tx-9',
      openingEntryId: 'entry-9',
      at: AT,
    });
    expect(() => WagerTransactionProcessed.from(processedBet(), stranger, context())).toThrow(
      InvalidIntegrationEventError,
    );
  });

  test('eventType and version live on the class', () => {
    const event = WagerTransactionProcessed.from(processedBet(), openedWallet().wallet, context());

    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
  });
});

function processedBet(): WagerTransaction {
  const transaction = bet();
  transaction.markProcessed(undefined, brl('975.00'), AT);
  return transaction;
}
