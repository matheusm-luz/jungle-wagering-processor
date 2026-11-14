import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GetTransaction } from '../../application/get-transaction';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { FailureCode } from '../../domain/failure-code';
import type { MoneyProps } from '../../domain/money';
import {
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { addLogContext, currentLogContext } from '../logging/log-context';
import { Metrics } from '../metrics/metrics';
import { IdempotencyKeyRequiredError } from './request-validation.error';
import {
  idempotencyKeySchema,
  identifierSchema,
  money,
  parse,
  uuidSchema,
  wagerSchema,
} from './validation';

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

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly getTransaction: GetTransaction,
    private readonly metrics: Metrics,
  ) {}

  @Post('wagering/transactions')
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

    const timer = this.metrics.processing.startTimer({ channel: 'http' });
    const { transaction, idempotentReplay } = await this.processWagerTransaction
      .execute({
        ...request,
        idempotencyKey: key,
        money: money('money', request.money),
        // Set by the correlation middleware for every request.
        correlationId: currentLogContext().correlationId ?? Bun.randomUUIDv7(),
      })
      .finally(timer);
    addLogContext({ transactionId: transaction.id });
    if (idempotentReplay) {
      this.metrics.duplicates.inc({ channel: 'http' });
    } else {
      this.metrics.transactions.inc({ channel: 'http', status: transaction.status });
    }

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
      ...visibleBalance(transaction),
      idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    const id = parse(uuidSchema, transactionId);
    return toView(await this.getTransaction.byId(id));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    const provider = parse(identifierSchema, providerId);
    const externalId = parse(identifierSchema, externalTransactionId);
    addLogContext({ providerId: provider });
    return toView(await this.getTransaction.byExternalId(provider, externalId));
  }
}

/** Statement §9 queries: the stored transaction, with the same balance rule as the `POST` answer. */
export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

/** The observed balance, absent for `WALLET_PLAYER_MISMATCH`: the wallet is not the caller's (L-20). */
function visibleBalance(transaction: WagerTransaction): { balance?: MoneyProps } {
  const { observedBalance, failureCode } = transaction;
  return observedBalance === undefined || failureCode === FailureCode.WalletPlayerMismatch
    ? {}
    : { balance: observedBalance.toJSON() };
}

function toView(transaction: WagerTransaction): TransactionView {
  addLogContext({ transactionId: transaction.id, walletId: transaction.walletId });
  const optional = <K extends string, V>(key: K, value: V | undefined) =>
    value === undefined ? {} : ({ [key]: value } as Record<K, V>);
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...optional('referenceExternalTransactionId', transaction.referenceExternalTransactionId),
    ...optional('referenceTransactionId', transaction.referenceTransactionId),
    status: transaction.status,
    ...optional('failureCode', transaction.failureCode),
    ...visibleBalance(transaction),
    createdAt: transaction.createdAt.toISOString(),
    ...optional('processedAt', transaction.processedAt?.toISOString()),
  };
}
