import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import type { Env } from './config/env';
import { correlationMiddleware } from './infrastructure/http/correlation.middleware';
import { JsonLogger } from './infrastructure/logging/json-logger';
import { NestLoggerAdapter } from './infrastructure/logging/nest-logger';

export interface CreateAppOptions {
  /** Replaces stdout as the log sink. Used by the tests to read what was logged. */
  writeLog?: (line: string) => void;
}

/** The single way to build the application: `main.ts` and the test suites both use it. */
export async function createApp(
  env: Env,
  options: CreateAppOptions = {},
): Promise<NestExpressApplication> {
  const logger = new JsonLogger({ level: env.LOG_LEVEL, write: options.writeLog });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env, logger), {
    logger: new NestLoggerAdapter(logger),
  });
  app.disable('x-powered-by');
  // Registered before the routes, so it wraps every request, including the ones that end in 404.
  app.use(correlationMiddleware(logger));
  // Runs the shutdown hooks on SIGTERM and SIGINT: connections are closed, not dropped.
  app.enableShutdownHooks();
  return app;
}
