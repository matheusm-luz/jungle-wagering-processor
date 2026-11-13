import { InvalidTransactionError } from '../domain/errors';
import type { EventContext } from '../domain/events/integration-event';
import type { Money } from '../domain/money';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InvalidWagerTransactionError,
  WalletNotFoundError,
} from './errors';
import { payloadHash } from './payload-hash';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import { settle, settlementEvents } from './settlement';

export interface ProcessWagerTransactionCommand {
  /** The `Idempotency-Key` header, or `data.idempotencyKey` on SQS. Not part of the hash. */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Required for `REFUND` and `ROLLBACK`, optional for `WIN` and `LOSS` (L-18). Hashed. */
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
}

export interface WagerTransactionResult {
  /** Terminal or pending; its status, failure code and observed balance are the answer. */
  transaction: WagerTransaction;
  /** True when the answer is the stored result of an earlier request with the same key. */
  idempotentReplay: boolean;
}

/**
 * The critical section of ARCHITECTURE §2, shared by HTTP and SQS. Everything that does not need
 * the database happens before the transaction opens; inside it the wallet lock comes first, so
 * every read after it sees what the previous holder committed.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const receivedAt = this.clock.now();
    const { idempotencyKey, correlationId, ...fields } = command;
    const transaction = this.create({
      ...fields,
      id: this.ids.newId(),
      idempotencyKey,
      payloadHash: payloadHash(fields),
      createdAt: receivedAt,
    });
    const entryId = this.ids.newId();

    return this.unitOfWork.run(async (scope) => {
      const wallet = await scope.wallets.lock(transaction.walletId);
      if (wallet === undefined) throw new WalletNotFoundError();

      // Under the lock: a request for this wallet that committed before is visible now (ADR-01).
      const known = await scope.transactions.findByIdentity(transaction);
      const sameKey = known.find((stored) => stored.idempotencyKey === idempotencyKey);
      if (sameKey !== undefined) {
        if (!sameKey.matchesPayload(transaction.payloadHash))
          throw new IdempotencyKeyConflictError();
        return { transaction: sameKey, idempotentReplay: true };
      }
      if (known.length > 0) throw new ExternalTransactionConflictError();

      // Read after the lock: a request that waited must not stamp its movement and events earlier
      // than the holder it waited for, or times would run against the wallet version (S4 review, m1).
      const at = this.clock.now();
      const context = (): EventContext => ({
        eventId: this.ids.newId(),
        correlationId,
        occurredAt: at,
      });

      const lockedVersion = wallet.version;
      const { entry, waiting } = await settle(scope, transaction, wallet, entryId, at);
      // A new row waits; the worker retries it (ADR-05).
      if (waiting) transaction.markPendingReference(wallet.balance);
      const events = settlementEvents(transaction, wallet, entry, context);

      // Foreign-key order: the transaction before its entry; the outbox rows last.
      await scope.transactions.insert(transaction, correlationId);
      if (entry !== undefined) {
        await scope.ledger.append(entry, transaction.counterparty());
        await scope.wallets.update(wallet, lockedVersion);
      }
      await scope.outbox.enqueue(events);
      return { transaction, idempotentReplay: false };
    });
  }

  /** The rules `WagerTransaction.create` enforces alone are request errors (L-03, L-18): 400. */
  private create(props: Parameters<typeof WagerTransaction.create>[0]): WagerTransaction {
    try {
      return WagerTransaction.create(props);
    } catch (error) {
      if (error instanceof InvalidTransactionError) {
        throw new InvalidWagerTransactionError(error.message);
      }
      throw error;
    }
  }
}
