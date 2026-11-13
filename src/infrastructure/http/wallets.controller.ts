import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { GetWallet } from '../../application/get-wallet';
import { OpenWallet } from '../../application/open-wallet';
import type { MoneyProps } from '../../domain/money';
import type { Wallet } from '../../domain/wallet';
import { addLogContext, currentLogContext } from '../logging/log-context';
import { identifierSchema, money, moneySchema, parse, uuidSchema } from './validation';

/** Closed field list: an unknown field is a 400, so nothing can vary silently. */
const openWalletSchema = z.strictObject({
  playerId: identifierSchema,
  initialBalance: moneySchema,
});

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

function toResponse(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async open(@Body() body: unknown): Promise<WalletResponse> {
    const request = parse(openWalletSchema, body);
    const wallet = await this.openWallet.execute({
      playerId: request.playerId,
      initialBalance: money('initialBalance', request.initialBalance),
      // Set by the correlation middleware for every request.
      correlationId: currentLogContext().correlationId ?? Bun.randomUUIDv7(),
    });
    addLogContext({ walletId: wallet.id });
    return toResponse(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletResponse> {
    const id = parse(uuidSchema, walletId);
    addLogContext({ walletId: id });
    return toResponse(await this.getWallet.execute(id));
  }
}
