import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { WalletQueries } from '../../application/ports';
import type { Wallet } from '../../domain/wallet';
import { toWallet } from './mappers';
import { WalletRecord } from './records';

@Injectable()
export class MikroOrmWalletQueries implements WalletQueries {
  constructor(private readonly orm: MikroORM) {}

  /** `walletId` must already be a UUID: anything else makes PostgreSQL raise 22P02. */
  async findById(walletId: string): Promise<Wallet | undefined> {
    const row = await this.orm.em.fork().findOne(WalletRecord, walletId);
    return row === null ? undefined : toWallet(row);
  }
}
