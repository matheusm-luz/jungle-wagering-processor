import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { GetLedger } from './application/get-ledger';
import { GetTransaction } from './application/get-transaction';
import { GetWallet } from './application/get-wallet';
import { OpenWallet } from './application/open-wallet';
import type {
  Clock,
  IdGenerator,
  ProviderIdentityPort,
  UnitOfWork,
  WalletQueries,
} from './application/ports';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { ReconcileWallet } from './application/reconcile-wallet';
import { ResolvePendingReferences } from './application/resolve-pending-references';
import {
  CLOCK,
  ID_GENERATOR,
  PROVIDER_IDENTITY,
  UNIT_OF_WORK,
  WALLET_QUERIES,
} from './application/tokens';
import type { Env } from './config/env';
import { ENV } from './config/env.token';
import { ReadinessService } from './infrastructure/health/readiness.service';
import { ANY_PROVIDER, AuthGuard } from './infrastructure/http/auth';
import { ErrorFilter } from './infrastructure/http/error.filter';
import { HealthController } from './infrastructure/http/health.controller';
import { MetricsController } from './infrastructure/http/metrics.controller';
import { WageringController } from './infrastructure/http/wagering.controller';
import { WalletsController } from './infrastructure/http/wallets.controller';
import { JsonLogger } from './infrastructure/logging/json-logger';
import { OutboxPublisher } from './infrastructure/messaging/outbox.publisher';
import { createSnsClient, SNS_CLIENT } from './infrastructure/messaging/sns.provider';
import { createSqsClient, SQS_CLIENT } from './infrastructure/messaging/sqs.provider';
import { WagerTransactionConsumer } from './infrastructure/messaging/wager-transaction.consumer';
import { BacklogGauges } from './infrastructure/metrics/backlog.gauges';
import { Metrics } from './infrastructure/metrics/metrics';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { MikroOrmWalletQueries } from './infrastructure/persistence/mikro-orm-wallet-queries';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';

const systemClock: Clock = { now: () => new Date() };
const uuidV7: IdGenerator = { newId: () => Bun.randomUUIDv7() };

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SNS_CLIENT) private readonly sns: SNSClient,
  ) {}

  static forRoot(env: Env, logger: JsonLogger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        MikroOrmModule.forRoot({
          ...buildOrmConfig(env, logger),
          // No request-scoped EntityManager: every use case, queue message and worker iteration
          // forks its own, so HTTP, SQS and workers follow one rule (ADR-13).
          registerRequestContext: false,
        }),
      ],
      controllers: [HealthController, MetricsController, WalletsController, WageringController],
      providers: [
        { provide: ENV, useValue: env },
        { provide: JsonLogger, useValue: logger },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(env) },
        { provide: SNS_CLIENT, useFactory: () => createSnsClient(env) },
        ReadinessService,
        { provide: APP_FILTER, useClass: ErrorFilter },
        // ADR-08: the extension point for an IdP. Both are no-ops until one exists.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: PROVIDER_IDENTITY, useValue: ANY_PROVIDER },
        { provide: CLOCK, useValue: systemClock },
        { provide: ID_GENERATOR, useValue: uuidV7 },
        { provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork },
        { provide: WALLET_QUERIES, useClass: MikroOrmWalletQueries },
        // Use cases are plain classes (the application layer does not import NestJS): built here.
        {
          provide: OpenWallet,
          useFactory: (unitOfWork: UnitOfWork, clock: Clock, ids: IdGenerator) =>
            new OpenWallet(unitOfWork, clock, ids),
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
        },
        {
          provide: ProcessWagerTransaction,
          useFactory: (
            unitOfWork: UnitOfWork,
            clock: Clock,
            ids: IdGenerator,
            identity: ProviderIdentityPort,
          ) => new ProcessWagerTransaction(unitOfWork, clock, ids, identity),
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, PROVIDER_IDENTITY],
        },
        {
          provide: ResolvePendingReferences,
          useFactory: (unitOfWork: UnitOfWork, clock: Clock, ids: IdGenerator) =>
            new ResolvePendingReferences(unitOfWork, clock, ids, {
              baseDelayMs: env.PENDING_REFERENCE_BASE_DELAY_MS,
              maxDelayMs: env.PENDING_REFERENCE_MAX_DELAY_MS,
              maxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
            }),
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
        },
        PendingReferenceWorker,
        WagerTransactionConsumer,
        OutboxPublisher,
        {
          provide: GetWallet,
          useFactory: (wallets: WalletQueries) => new GetWallet(wallets),
          inject: [WALLET_QUERIES],
        },
        {
          provide: GetTransaction,
          useFactory: (wallets: WalletQueries) => new GetTransaction(wallets),
          inject: [WALLET_QUERIES],
        },
        {
          provide: GetLedger,
          useFactory: (wallets: WalletQueries) => new GetLedger(wallets),
          inject: [WALLET_QUERIES],
        },
        {
          provide: ReconcileWallet,
          useFactory: (wallets: WalletQueries) => new ReconcileWallet(wallets),
          inject: [WALLET_QUERIES],
        },
        Metrics,
        BacklogGauges,
      ],
    };
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
    this.sns.destroy();
  }
}
