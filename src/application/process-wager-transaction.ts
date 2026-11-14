import { InvalidTransactionError } from '../domain/errors';
import type { EventContext } from '../domain/events/integration-event';
import type { Money } from '../domain/money';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InboxMessageConflictError,
  InvalidWagerTransactionError,
  WalletNotFoundError,
} from './errors';
import { inboxHash, payloadHash } from './payload-hash';
import type { Clock, IdGenerator, ProviderIdentityPort, UnitOfWork } from './ports';
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

/** The queue message behind a command: the inbox key (statement §10). */
export interface InboxMessage {
  consumerName: string;
  messageId: string;
}

/**
 * Over SQS two more answers exist, both committed and acknowledged: the message was already
 * processed, or it names an unknown wallet and only its inbox row is kept (L-08).
 */
export type MessageResult = WagerTransactionResult | 'duplicate' | 'walletNotFound';

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
    private readonly identity: ProviderIdentityPort,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    // Before BEGIN: a refused caller takes no lock and writes nothing. The queue is a trusted
    // internal channel and is not checked (statement §2).
    this.identity.assertMayActFor(command.providerId);
    // Without a message neither `duplicate` nor `walletNotFound` is produced: the latter throws.
    return (await this.process(command, undefined)) as WagerTransactionResult;
  }

  /** The SQS entry: the inbox row is the first write of the same transaction (ARCHITECTURE §2 step 4). */
  executeMessage(
    command: ProcessWagerTransactionCommand,
    message: InboxMessage,
  ): Promise<MessageResult> {
    return this.process(command, message);
  }

  private async process(
    command: ProcessWagerTransactionCommand,
    message: InboxMessage | undefined,
  ): Promise<MessageResult> {
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

    return this.unitOfWork.run(async (scope): Promise<MessageResult> => {
      if (message !== undefined) {
        // Before the wallet lock: a redelivery stops here, and commits nothing new.
        const inbox = await scope.inbox.record({
          ...message,
          payloadHash: inboxHash(transaction.payloadHash, idempotencyKey),
          at: receivedAt,
        });
        if (inbox === 'duplicate') return 'duplicate';
        if (inbox === 'conflict') throw new InboxMessageConflictError();
      }

      const wallet = await scope.wallets.lock(transaction.walletId);
      if (wallet === undefined) {
        // L-08: over SQS the inbox row commits alone, so a wallet created later never sees it.
        if (message !== undefined) return 'walletNotFound';
        throw new WalletNotFoundError();
      }

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
