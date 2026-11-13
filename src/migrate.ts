import { loadEnv } from './config/env';
import { JsonLogger } from './infrastructure/logging/json-logger';
import { runMigrations } from './infrastructure/persistence/migration-runner';

// Usage: bun src/migrate.ts <up|down>
const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  process.stderr.write('usage: bun src/migrate.ts <up|down>\n');
  process.exit(2);
}

const env = loadEnv(process.env);
const logger = new JsonLogger({ level: env.LOG_LEVEL });

try {
  const names = await runMigrations(env, logger, direction);
  logger.info('migrations finished', { direction, count: names.length, names: names.join(',') });
} catch (error) {
  logger.error('migrations failed', { direction }, error);
  process.exit(1);
}
