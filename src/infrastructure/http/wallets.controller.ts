import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { GetLedger } from '../../application/get-ledger';
import { GetWallet } from '../../application/get-wallet';
import { OpenWallet } from '../../application/open-wallet';
import { ReconcileWallet, type Reconciliation } from '../../application/reconcile-wallet';
import type { MoneyProps } from '../../domain/money';
import type { Wallet } from '../../domain/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { JsonLogger } from '../logging/json-logger';
import { addLogContext, currentLogContext } from '../logging/log-context';
import { Metrics } from '../metrics/metrics';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import { RequestValidationError } from './request-validation.error';
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
    private readonly getLedger: GetLedger,
    private readonly reconcileWallet: ReconcileWallet,
    private readonly metrics: Metrics,
    private readonly logger: JsonLogger,
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

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ): Promise<LedgerPageResponse> {
    const id = parse(uuidSchema, walletId);
    const query = parse(ledgerQuerySchema, { cursor, limit });
    addLogContext({ walletId: id });
    const after = query.cursor === undefined ? 0 : decodeLedgerCursor(query.cursor, id);
    if (after === undefined) {
      throw new RequestValidationError('cursor: is not a ledger cursor');
    }

    const page = await this.getLedger.execute(id, after, query.limit);
    const last = page.entries.at(-1);
    return {
      items: page.entries.map(toEntryResponse),
      // The last page keeps its cursor, so a reader resumes where it stopped once more entries exist.
      nextCursor:
        last === undefined ? (query.cursor ?? null) : encodeLedgerCursor(id, last.sequence),
      hasMore: page.hasMore,
    };
  }

  /** Writes nothing: a divergence is logged, counted and answered, never fixed (R-49). */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string): Promise<Reconciliation> {
    const id = parse(uuidSchema, walletId);
    addLogContext({ walletId: id });
    const result = await this.reconcileWallet.execute(id);
    if (!result.consistent) {
      this.metrics.increment(RECONCILIATION_DIVERGENCES);
      // No amounts in logs: the response carries them.
      this.logger.error('wallet reconciliation divergence', {
        walletId: id,
        checkedEntries: result.checkedEntries,
      });
    }
    return result;
  }
}

export const RECONCILIATION_DIVERGENCES = 'wallet_reconciliation_divergences_total';

/** Default 50 as in statement §9; at most 200 so one request stays one cheap index range. */
const ledgerQuerySchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/, 'must be an integer from 1 to 200')
    .transform(Number)
    .refine((value) => value <= 200, 'must be an integer from 1 to 200')
    .optional()
    .default(50),
});

export interface LedgerEntryResponse {
  entryId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  sequence: number;
  createdAt: string;
}

export interface LedgerPageResponse {
  items: LedgerEntryResponse[];
  nextCursor: string | null;
  hasMore: boolean;
}

function toEntryResponse(entry: WalletLedgerEntry): LedgerEntryResponse {
  return {
    entryId: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    sequence: entry.sequence,
    createdAt: entry.createdAt.toISOString(),
  };
}
