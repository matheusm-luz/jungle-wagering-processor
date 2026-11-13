import { createHash } from 'node:crypto';
import type { Money } from '../domain/money';
import type { WagerTransactionKind } from '../domain/wager-transaction';

/**
 * The closed list of business fields that identify a request (ADR-03). The idempotency key, the
 * SQS `messageId`, `occurredAt` and every other transport field are not here, so the same business
 * request hashes identically over HTTP and SQS.
 */
export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * SHA-256, lowercase hex, over canonical JSON: a flat object of the fields above, keys sorted, no
 * whitespace, UTF-8, every value a string. The amount comes from the normalised `Money`, and the
 * reference is present only when declared.
 */
export function payloadHash(fields: PayloadHashFields): string {
  const canonical: Record<string, string> = {
    amount: fields.money.amount,
    currency: fields.money.currency,
    externalTransactionId: fields.externalTransactionId,
    gameId: fields.gameId,
    kind: fields.kind,
    playerId: fields.playerId,
    providerId: fields.providerId,
    roundId: fields.roundId,
    walletId: fields.walletId,
  };
  if (fields.referenceExternalTransactionId !== undefined) {
    canonical.referenceExternalTransactionId = fields.referenceExternalTransactionId;
  }

  const sorted = Object.fromEntries(
    Object.entries(canonical).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}

/**
 * What the inbox compares for one message id: the business payload and the idempotency key. The
 * key is part of the message, so the same id with another key is a conflict, not a duplicate that
 * would hide it (PR #9 review); the transaction's own hash stays key-free (ADR-03).
 */
export function inboxHash(payloadHashValue: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${payloadHashValue}:${idempotencyKey}`, 'utf8').digest('hex');
}
