import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '../../config/env';
import { ENV } from '../../config/env.token';
import { JsonLogger } from '../logging/json-logger';
import { SQS_CLIENT } from '../messaging/sqs.provider';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: { postgres: DependencyStatus; sqs: DependencyStatus };
}

@Injectable()
export class ReadinessService {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: JsonLogger,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.probe('postgres', () => this.pingPostgres()),
      this.probe('sqs', (signal) => this.pingSqs(signal)),
    ]);
    return {
      status: postgres === 'up' && sqs === 'up' ? 'ok' : 'unavailable',
      checks: { postgres, sqs },
    };
  }

  /**
   * Every probe is bounded by `READINESS_TIMEOUT_MS`: a dependency that accepts the connection
   * and never answers must turn into `down`, not into a readiness request that hangs.
   */
  private async probe(
    dependency: keyof ReadinessReport['checks'],
    ping: (signal: AbortSignal) => Promise<void>,
  ): Promise<DependencyStatus> {
    const timeoutMs = this.env.READINESS_TIMEOUT_MS;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`no answer within ${timeoutMs} ms`));
      }, timeoutMs);
    });

    try {
      await Promise.race([ping(abort.signal), timeout]);
      return 'up';
    } catch (error) {
      // The cause goes to the log only: the endpoint is unauthenticated.
      this.logger.warn('readiness check failed', { dependency, ...describe(error) });
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A real round trip on a pooled connection. MikroORM 7 connects lazily, so its own
   * `checkConnection()` answers "not established" until some query has run; `execute` connects
   * on first use.
   */
  private async pingPostgres(): Promise<void> {
    await this.orm.em.getConnection().execute('select 1');
  }

  /** Resolving the queue proves both that SQS answers and that the queue was provisioned. */
  private async pingSqs(abortSignal: AbortSignal): Promise<void> {
    await this.sqs.send(
      new GetQueueUrlCommand({ QueueName: this.env.WAGER_TRANSACTIONS_QUEUE_NAME }),
      { abortSignal },
    );
  }
}

function describe(error: unknown): { errorName: string; errorMessage: string } {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorName: 'NonError', errorMessage: String(error) };
}
