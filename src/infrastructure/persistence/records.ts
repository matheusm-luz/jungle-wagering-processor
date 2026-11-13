import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/**
 * Persistence records (ADR-10): the shape of each row, nothing more. The domain never sees them;
 * `mappers.ts` turns them into domain objects through `rehydrate`. The schema is the hand-written
 * migration, so these declarations only have to match it: they generate nothing.
 *
 * Foreign keys are plain uuid columns, not ORM relations: the repositories flush in foreign-key
 * order themselves, and no lazy reference can load a row outside the wallet lock.
 *
 * `NUMERIC` comes back from the driver as a string, never a float (ADR-02).
 */

export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.text(),
    currency: p.string().columnType('char(3)'),
    balance: p.decimal().columnType('numeric(19,2)'),
    version: p.integer(),
    createdAt: p.datetime().columnType('timestamptz'),
    updatedAt: p.datetime().columnType('timestamptz'),
  },
});
export type WalletRow = InferEntity<typeof WalletRecord>;

export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.string().columnType('char(64)'),
    walletId: p.uuid(),
    playerId: p.text(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.text(),
    amount: p.decimal().columnType('numeric(19,2)'),
    currency: p.string().columnType('char(3)'),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.text(),
    failureCode: p.text().nullable(),
    observedBalance: p.decimal().columnType('numeric(19,2)').nullable(),
    observedCurrency: p.string().columnType('char(3)').nullable(),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
    // Bookkeeping of the pending-reference worker (S7); the domain does not model it.
    referenceAttempts: p.integer(),
    nextAttemptAt: p.datetime().columnType('timestamptz').nullable(),
    // The creating request's correlation id (L-15), for the events the worker emits later.
    correlationId: p.text().nullable(),
    createdAt: p.datetime().columnType('timestamptz'),
  },
});
export type WagerTransactionRow = InferEntity<typeof WagerTransactionRecord>;

export const LedgerEntryRecord = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    counterpartyAccountId: p.uuid(),
    direction: p.text(),
    amount: p.decimal().columnType('numeric(19,2)'),
    currency: p.string().columnType('char(3)'),
    balanceBefore: p.decimal().columnType('numeric(19,2)'),
    balanceAfter: p.decimal().columnType('numeric(19,2)'),
    sequence: p.integer(),
    createdAt: p.datetime().columnType('timestamptz'),
  },
});
export type LedgerEntryRow = InferEntity<typeof LedgerEntryRecord>;

export const OutboxMessageRecord = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    /** The event id. */
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.text(),
    payload: p.json<Record<string, unknown>>().columnType('jsonb'),
    occurredAt: p.datetime().columnType('timestamptz'),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType('timestamptz'),
    publishedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});
export type OutboxMessageRow = InferEntity<typeof OutboxMessageRecord>;

/** The explicit entity list of the ORM configuration (no globs). */
export const records = [
  WalletRecord,
  WagerTransactionRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
];
