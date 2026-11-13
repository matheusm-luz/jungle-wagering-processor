import type { NextFunction, Request, Response } from 'express';
import type { JsonLogger } from '../logging/json-logger';
import { currentLogContext, runWithLogContext } from '../logging/log-context';

export const CORRELATION_HEADER = 'X-Correlation-Id';

/** A caller-supplied id is trusted only if it is short and made of harmless characters. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Opens the log context of an HTTP request: takes the correlation id from `X-Correlation-Id` or
 * generates one, echoes it in the response and runs the rest of the request inside the context,
 * so every line logged while handling it carries the id. Also writes one access line per
 * request, with the path only: never the query string, the headers or the body.
 */
export function correlationMiddleware(logger: JsonLogger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const supplied = request.header(CORRELATION_HEADER);
    const correlationId =
      supplied !== undefined && SAFE_CORRELATION_ID.test(supplied) ? supplied : Bun.randomUUIDv7();
    response.setHeader(CORRELATION_HEADER, correlationId);

    runWithLogContext({ correlationId }, () => {
      // Kept by reference: `finish` fires outside this async context, and by then the request
      // may have added identifiers such as `walletId`.
      const context = currentLogContext();
      const { method, path } = request;
      const startedAt = performance.now();

      response.on('finish', () => {
        const fields = {
          ...context,
          method,
          path,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        };
        // Probes hit the health endpoints every few seconds; keep them out of the default level.
        if (path.startsWith('/health/')) {
          logger.debug('http request', fields);
        } else {
          logger.info('http request', fields);
        }
      });

      next();
    });
  };
}
