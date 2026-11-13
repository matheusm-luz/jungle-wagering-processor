import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Env } from './config/env';
import { ENV } from './config/env.token';
import { ReadinessService } from './infrastructure/health/readiness.service';
import { HealthController } from './infrastructure/http/health.controller';
import { JsonLogger } from './infrastructure/logging/json-logger';
import { createSqsClient, SQS_CLIENT } from './infrastructure/messaging/sqs.provider';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

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
      controllers: [HealthController],
      providers: [
        { provide: ENV, useValue: env },
        { provide: JsonLogger, useValue: logger },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(env) },
        ReadinessService,
      ],
    };
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
