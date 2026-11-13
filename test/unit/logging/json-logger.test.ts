import { describe, expect, test } from 'bun:test';
import {
  JsonLogger,
  type LogLevelThreshold,
} from '../../../src/infrastructure/logging/json-logger';
import { addLogContext, runWithLogContext } from '../../../src/infrastructure/logging/log-context';
import { NestLoggerAdapter } from '../../../src/infrastructure/logging/nest-logger';

const NOW = new Date('2026-11-13T12:00:00.000Z');

function capture(level: LogLevelThreshold = 'debug') {
  const lines: string[] = [];
  const logger = new JsonLogger({ level, write: (line) => lines.push(line), now: () => NOW });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

describe('JsonLogger', () => {
  test('writes one JSON object per line', () => {
    const { logger, lines, records } = capture();

    logger.info('wallet opened', { walletId: 'w-1', attempts: 2, replay: false });
    logger.warn('line\nbreak');

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('\n');
    }
    expect(records()[0]).toEqual({
      level: 'info',
      time: '2026-11-13T12:00:00.000Z',
      message: 'wallet opened',
      walletId: 'w-1',
      attempts: 2,
      replay: false,
    });
    expect(records()[1]?.message).toBe('line\nbreak');
  });

  test('adds the fields of the current log context', () => {
    const { logger, records } = capture();

    runWithLogContext({ correlationId: 'c-1', messageId: 'm-1' }, () => {
      addLogContext({ transactionId: 't-1', walletId: 'w-1', providerId: 'p-1' });
      logger.info('processed');
    });
    logger.info('outside');

    expect(records()[0]).toMatchObject({
      correlationId: 'c-1',
      messageId: 'm-1',
      transactionId: 't-1',
      walletId: 'w-1',
      providerId: 'p-1',
    });
    expect(records()[1]).not.toHaveProperty('correlationId');
  });

  test('keeps contexts of concurrent async flows apart', async () => {
    const { logger, records } = capture();

    const flow = (correlationId: string, delayMs: number) =>
      runWithLogContext({ correlationId }, async () => {
        await Bun.sleep(delayMs);
        addLogContext({ walletId: `wallet-of-${correlationId}` });
        await Bun.sleep(delayMs);
        logger.info('done');
      });

    await Promise.all([flow('a', 15), flow('b', 5), flow('c', 10)]);

    expect(records()).toHaveLength(3);
    for (const record of records()) {
      expect(record.walletId).toBe(`wallet-of-${record.correlationId}`);
    }
  });

  test('drops lines below the configured level', () => {
    const { logger, records } = capture('warn');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(records().map((record) => record.level)).toEqual(['warn', 'error']);
  });

  test('writes nothing when silent', () => {
    const { logger, lines } = capture('silent');

    logger.error('e');

    expect(lines).toHaveLength(0);
  });

  test('flattens an error into name, message and stack', () => {
    const { logger, records } = capture();

    logger.error('publish failed', { attempts: 3 }, new RangeError('boom'));
    logger.error('odd throw', {}, 'just a string');

    expect(records()[0]).toMatchObject({
      level: 'error',
      message: 'publish failed',
      attempts: 3,
      errorName: 'RangeError',
      errorMessage: 'boom',
    });
    expect(records()[0]?.stack).toContain('RangeError: boom');
    expect(records()[1]).toMatchObject({ errorName: 'NonError', errorMessage: 'just a string' });
  });

  test('never lets a field replace level, time or message', () => {
    const { logger, records } = capture();

    logger.info('real', { level: 'fake', time: 'fake', message: 'fake' });

    expect(records()[0]).toEqual({
      level: 'info',
      time: '2026-11-13T12:00:00.000Z',
      message: 'real',
    });
  });
});

describe('NestLoggerAdapter', () => {
  test('maps a NestJS log call to a JSON line with its context', () => {
    const { logger, records } = capture();
    const nest = new NestLoggerAdapter(logger);

    nest.log('Nest application successfully started', 'NestApplication');
    nest.warn('careful');

    expect(records()[0]).toMatchObject({
      level: 'info',
      message: 'Nest application successfully started',
      context: 'NestApplication',
    });
    expect(records()[1]).toMatchObject({ level: 'warn', message: 'careful' });
  });

  test('keeps the stack NestJS passes to error()', () => {
    const { logger, records } = capture();
    const nest = new NestLoggerAdapter(logger);
    const failure = new TypeError('bad');

    nest.error('request failed', failure.stack, 'ExceptionsHandler');
    nest.error(failure, 'ExceptionsHandler');

    expect(records()[0]).toMatchObject({
      level: 'error',
      message: 'request failed',
      context: 'ExceptionsHandler',
    });
    expect(records()[0]?.stack).toContain('TypeError: bad');
    expect(records()[1]).toMatchObject({
      level: 'error',
      message: 'bad',
      errorName: 'TypeError',
      context: 'ExceptionsHandler',
    });
  });
});
