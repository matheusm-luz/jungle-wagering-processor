import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { FailureCode } from '../../domain/failure-code';
import type { MoneyProps } from '../../domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { addLogContext, currentLogContext } from '../logging/log-context';
import { IdempotencyKeyRequiredError } from './request-validation.error';
import {
  idempotencyKeySchema,
  identifierSchema,
  money,
  moneySchema,
  parse,
  uuidSchema,
} from './validation';

/**
 * Closed field list (ADR-03): an unknown field is a 400, so nothing outside the hash can vary.
 * `OPENING` is internal. Which kinds require, accept or refuse a reference (L-18) is checked by
 * `WagerTransaction.create`, also a 400.
 */
const wagerSchema = z.strictObject({
  providerId: identifierSchema.refine((value) => value !== 'SYSTEM', 'is reserved'),
  externalTransactionId: identifierSchema,
  playerId: identifierSchema,
  walletId: uuidSchema,
  roundId: identifierSchema,
  gameId: identifierSchema,
  kind: z.enum([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ]),
  money: moneySchema,
  referenceExternalTransactionId: identifierSchema.optional(),
});

/** ADR-06: the status comes from the persisted state, so a replay answers like the first call. */
const HTTP_STATUS: Partial<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
};

export interface WagerTransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  /**
   * The balance observed when the transaction reached its status (statement §7.7). Absent for
   * `WALLET_PLAYER_MISMATCH`: the wallet is not the caller's (L-20); the row keeps it for audit.
   */
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly processWagerTransaction: ProcessWagerTransaction) {}

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerTransactionResponse> {
    if (idempotencyKey === undefined || idempotencyKey === '') {
      throw new IdempotencyKeyRequiredError();
    }
    const key = parse(idempotencyKeySchema, idempotencyKey);
    const request = parse(wagerSchema, body);
    addLogContext({ walletId: request.walletId, providerId: request.providerId });

    const { transaction, idempotentReplay } = await this.processWagerTransaction.execute({
      ...request,
      idempotencyKey: key,
      money: money('money', request.money),
      // Set by the correlation middleware for every request.
      correlationId: currentLogContext().correlationId ?? Bun.randomUUIDv7(),
    });
    addLogContext({ transactionId: transaction.id });

    const status = HTTP_STATUS[transaction.status];
    const { observedBalance, failureCode } = transaction;
    // shortcut: FAILED has no HTTP status in ARCHITECTURE §6 yet and S4 never produces it; S12 decides.
    if (status === undefined || observedBalance === undefined) {
      throw new Error(`No HTTP answer for a ${transaction.status} transaction`);
    }
    response.status(status);
    return {
      transactionId: transaction.id,
      status: transaction.status,
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(failureCode === FailureCode.WalletPlayerMismatch
        ? {}
        : { balance: observedBalance.toJSON() }),
      idempotentReplay,
    };
  }
}
