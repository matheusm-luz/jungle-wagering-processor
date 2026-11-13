import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import type { Money } from '../domain/money';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { payloadHash } from './payload-hash';
import type { Clock, IdGenerator, UnitOfWork } from './ports';

/**
 * Identity of the internal `OPENING` transaction (docs/tasks/S3.md, Q2). It has to satisfy the
 * same constraints as a provider's transaction. A provider that calls itself `SYSTEM` and reuses
 * such an id only meets a unique constraint, which is a 409.
 */
export const OPENING_PROVIDER_ID = 'SYSTEM';
const OPENING_ROUND_AND_GAME = 'OPENING';
const openingExternalId = (walletId: string) => `opening:${walletId}`;

export interface OpenWalletCommand {
  playerId: string;
  /** Zero or positive; its currency becomes the wallet currency. */
  initialBalance: Money;
  correlationId: string;
}

/**
 * `POST /wallets` (statement §9, R-43). A positive opening balance is an internal `OPENING`
 * transaction with its `CREDIT` entry against `FUNDING`, written with the wallet and the outbox
 * events in one SQL transaction. A zero balance moves nothing: the wallet alone, no event.
 *
 * There is no lock: the wallet does not exist yet. `UNIQUE (player_id, currency)` decides between
 * two concurrent openings, and the loser becomes `WalletAlreadyExistsError` (409).
 */
export class OpenWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const at = this.clock.now();
    const walletId = this.ids.newId();
    const openingTransactionId = this.ids.newId();

    // Everything is built before the transaction opens, so it stays as short as the writes.
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.newId(),
      at,
    });

    if (openingEntry === undefined) {
      await this.unitOfWork.run((scope) => scope.wallets.insert(wallet));
      return wallet;
    }

    const externalTransactionId = openingExternalId(walletId);
    const identity = {
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId,
      playerId: command.playerId,
      walletId,
      roundId: OPENING_ROUND_AND_GAME,
      gameId: OPENING_ROUND_AND_GAME,
      kind: WagerTransactionKind.Opening,
      money: command.initialBalance,
    };
    const opening = WagerTransaction.create({
      ...identity,
      id: openingTransactionId,
      idempotencyKey: externalTransactionId,
      payloadHash: payloadHash(identity),
      createdAt: at,
    });
    opening.markProcessed(undefined, wallet.balance, at);

    const context = (eventId: string) => ({
      eventId,
      correlationId: command.correlationId,
      occurredAt: at,
    });
    const events = [
      WagerTransactionProcessed.from(opening, wallet, context(this.ids.newId())),
      WalletBalanceChanged.from(wallet, openingEntry, context(this.ids.newId())),
    ];

    // Foreign-key order: wallet, transaction, entry; the outbox rows last.
    await this.unitOfWork.run(async (scope) => {
      await scope.wallets.insert(wallet);
      await scope.transactions.insert(opening, command.correlationId);
      await scope.ledger.append(openingEntry, opening.counterparty());
      await scope.outbox.enqueue(events);
    });
    return wallet;
  }
}
