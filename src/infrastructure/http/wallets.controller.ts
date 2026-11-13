import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { GetWallet } from '../../application/get-wallet';
import { OpenWallet } from '../../application/open-wallet';
import { InvalidMoneyError } from '../../domain/errors';
import { Money, type MoneyProps } from '../../domain/money';
import type { Wallet } from '../../domain/wallet';
import { addLogContext, currentLogContext } from '../logging/log-context';
import { RequestValidationError } from './request-validation.error';

/**
 * Closed field lists: an unknown field is a 400, so nothing can vary silently. Amount and currency
 * are only typed here; their format is the job of `Money.from`, the single owner of L-02 and L-17.
 */
const moneySchema = z.strictObject({ amount: z.string(), currency: z.string() });
const openWalletSchema = z.strictObject({
  playerId: z
    .string()
    .min(1)
    .max(128)
    // PostgreSQL cannot store U+0000 in `text`: refused here, or it would be a driver error.
    .refine((value) => !value.includes(String.fromCharCode(0)), 'must not contain U+0000'),
  initialBalance: moneySchema,
});
const walletIdSchema = z.uuid();

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

/** Field paths and reasons only, never the values: they can be financial data. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
    .join('; ');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RequestValidationError(describeIssues(result.error));
  }
  return result.data;
}

function money(props: MoneyProps): Money {
  try {
    return Money.from(props);
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new RequestValidationError(`initialBalance: ${error.message}`);
    }
    throw error;
  }
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
      initialBalance: money(request.initialBalance),
      // Set by the correlation middleware for every request.
      correlationId: currentLogContext().correlationId ?? Bun.randomUUIDv7(),
    });
    addLogContext({ walletId: wallet.id });
    return toResponse(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletResponse> {
    const id = parse(walletIdSchema, walletId);
    addLogContext({ walletId: id });
    return toResponse(await this.getWallet.execute(id));
  }
}
