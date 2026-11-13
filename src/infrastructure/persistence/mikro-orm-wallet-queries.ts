import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { ReconciliationInput, WalletQueries } from '../../application/ports';
import { Money } from '../../domain/money';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { toLedgerEntry, toWagerTransaction, toWallet } from './mappers';
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './records';

/** Every id passed here must already be a UUID: anything else makes PostgreSQL raise 22P02. */
@Injectable()
export class MikroOrmWalletQueries implements WalletQueries {
  constructor(private readonly orm: MikroORM) {}

  async findById(walletId: string): Promise<Wallet | undefined> {
    const row = await this.orm.em.fork().findOne(WalletRecord, walletId);
    return row === null ? undefined : toWallet(row);
  }

  async findTransactionById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.orm.em.fork().findOne(WagerTransactionRecord, id);
    return row === null ? undefined : toWagerTransaction(row);
  }

  async findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.orm.em
      .fork()
      .findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return row === null ? undefined : toWagerTransaction(row);
  }

  async ledgerPage(
    walletId: string,
    afterSequence: number,
    limit: number,
  ): Promise<WalletLedgerEntry[] | undefined> {
    const em = this.orm.em.fork();
    // Served by UNIQUE (wallet_id, sequence).
    const rows = await em.find(
      LedgerEntryRecord,
      { walletId, sequence: { $gt: afterSequence } },
      { orderBy: { sequence: 'asc' }, limit },
    );
    // Wallets are never deleted, so an empty page of an existing wallet stays a valid answer.
    if (rows.length === 0 && (await em.count(WalletRecord, walletId)) === 0) return undefined;
    return rows.map(toLedgerEntry);
  }

  async reconciliationInput(walletId: string): Promise<ReconciliationInput | undefined> {
    // One statement, one snapshot at READ COMMITTED. Sums stay at scale 2; one beyond NUMERIC(19,2)
    // (10^17 of turnover on one wallet) is refused by Money.from: a documented limitation.
    const [row] = await this.orm.em
      .fork()
      .execute<
        { balance: string; currency: string; credits: string; debits: string; entries: number }[]
      >(
        `select w.balance, w.currency,
              coalesce(sum(e.amount) filter (where e.direction = 'CREDIT'), 0)::numeric(38, 2)::text
                as credits,
              coalesce(sum(e.amount) filter (where e.direction = 'DEBIT'), 0)::numeric(38, 2)::text
                as debits,
              count(e.id)::integer as entries
         from wallets w
         left join wallet_ledger_entries e on e.wallet_id = w.id
        where w.id = ?
        group by w.id`,
        [walletId],
      );
    if (row === undefined) return undefined;
    const money = (amount: string) => Money.from({ amount, currency: row.currency });
    return {
      walletId,
      stored: money(row.balance),
      credits: money(row.credits),
      debits: money(row.debits),
      entries: row.entries,
    };
  }
}
