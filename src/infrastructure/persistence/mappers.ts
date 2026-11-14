import type { RequiredEntityData } from '@mikro-orm/core';
import { FailureCode } from '../../domain/failure-code';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { LedgerEntryRow, OutboxMessageRow, WagerTransactionRow, WalletRow } from './records';

/**
 * Domain ⇄ record. Reading goes through `rehydrate`, which validates nothing (statement §6.0);
 * the schema already guarantees what was written. Two rules hold in every function below:
 * a `NULL` column becomes `undefined`, because every optional check in the domain is
 * `=== undefined`; and a `TEXT` column becomes an enum only if it is one of its values.
 */

/** Undefined for `NULL`. The domain counts a `null` reference as a declared one. */
function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/** The enum value equal to `value`. The schema's `CHECK` lists the same values, so this never throws on valid rows. */
function enumValue<E extends Record<string, string>>(values: E, value: string): E[keyof E] {
  const match = Object.values(values).find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`Unknown value read from the database: ${value}`);
  }
  return match as E[keyof E];
}

// ---- Wallet

export function toWalletRecord(wallet: Wallet): RequiredEntityData<WalletRow> {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// ---- Wager transaction

/** A new row. A waiting one is due at once (S6, Q1); the worker owns attempts and backoff after that. */
export function toWagerTransactionRecord(
  transaction: WagerTransaction,
  correlationId?: string,
): RequiredEntityData<WagerTransactionRow> {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    observedBalance: transaction.observedBalance?.amount ?? null,
    observedCurrency: transaction.observedBalance?.currency ?? null,
    processedAt: transaction.processedAt ?? null,
    referenceAttempts: 0,
    nextAttemptAt:
      transaction.status === WagerTransactionStatus.PendingReference ? transaction.createdAt : null,
    correlationId: correlationId ?? null,
    createdAt: transaction.createdAt,
  };
}

export function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  const failureCode = optional(row.failureCode);
  const observedBalance = optional(row.observedBalance);
  const observedCurrency = optional(row.observedCurrency);

  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: enumValue(WagerTransactionKind, row.kind),
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: optional(row.referenceExternalTransactionId),
    createdAt: row.createdAt,
    status: enumValue(WagerTransactionStatus, row.status),
    referenceTransactionId: optional(row.referenceTransactionId),
    failureCode: failureCode === undefined ? undefined : enumValue(FailureCode, failureCode),
    // The schema keeps both columns null or both set (wager_transactions_observed_balance_complete).
    observedBalance:
      observedBalance === undefined || observedCurrency === undefined
        ? undefined
        : Money.from({ amount: observedBalance, currency: observedCurrency }),
    processedAt: optional(row.processedAt),
  });
}

// ---- Ledger entry

/** `counterpartyAccountId` is resolved by the repository from `WagerTransaction.counterparty()`. */
export function toLedgerEntryRecord(
  entry: WalletLedgerEntry,
  counterpartyAccountId: string,
): RequiredEntityData<LedgerEntryRow> {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    counterpartyAccountId,
    direction: entry.direction,
    amount: entry.money.amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    sequence: entry.sequence,
    createdAt: entry.createdAt,
  };
}

export function toLedgerEntry(row: LedgerEntryRow): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: row.currency });
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: enumValue(LedgerDirection, row.direction),
    money: money(row.amount),
    balanceBefore: money(row.balanceBefore),
    balanceAfter: money(row.balanceAfter),
    sequence: row.sequence,
    createdAt: row.createdAt,
  });
}

// ---- Outbox

export function toOutboxMessageRecord(
  message: OutboxMessage,
): RequiredEntityData<OutboxMessageRow> {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt ?? null,
  };
}

export function toOutboxMessage(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    publishedAt: optional(row.publishedAt),
  });
}
