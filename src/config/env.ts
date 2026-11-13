import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// URL'),
  /** The `pg` driver has no connect timeout by default: a hung server would hang every caller. */
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),
  /** ADR-01: a wallet lock waited for longer than this fails its transaction (55P03), a transient error. */
  DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  /** Set for LocalStack; left unset on AWS, where the SDK resolves the regional endpoint. */
  AWS_ENDPOINT_URL: z.url().optional(),
  WAGER_TRANSACTIONS_QUEUE_NAME: z.string().min(1).default('wager-transactions.fifo'),
  WAGER_TRANSACTIONS_DLQ_NAME: z.string().min(1).default('wager-transactions-dlq.fifo'),
  // SQS consumer (ADR-05, docs/tasks/S9.md Q3). SQS takes seconds; tests shrink them.
  SQS_CONSUMER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  SQS_WAIT_TIME_S: z.coerce.number().int().min(0).max(20).default(10),
  SQS_VISIBILITY_TIMEOUT_S: z.coerce.number().int().min(0).max(43_200).default(30),
  SQS_RETRY_BASE_DELAY_S: z.coerce.number().int().min(0).default(5),
  SQS_RETRY_MAX_DELAY_S: z.coerce.number().int().min(0).max(43_200).default(120),
  SQS_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10_000),
  /** ADR-09: test-only. `crash-after-commit` kills the process between commit and ack (R-68). */
  SQS_CONSUMER_FAILPOINT: z.enum(['crash-after-commit']).optional(),
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(1).default(2000),
  // Pending-reference worker (ADR-05). Tests shrink the delays to milliseconds.
  PENDING_REFERENCE_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1000),
  PENDING_REFERENCE_MAX_DELAY_MS: z.coerce.number().int().min(1).default(60_000),
  PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().min(1).default(500),
  PENDING_REFERENCE_BATCH_SIZE: z.coerce.number().int().min(1).default(10),
});

export type Env = Readonly<z.infer<typeof schema>>;

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
}

/**
 * Parses the environment once, at boot, and fails fast.
 * The error lists variable names and reasons only, never values: `DATABASE_URL` carries a password.
 */
export function loadEnv(source: Readonly<Record<string, string | undefined>>): Env {
  // An empty value (`PORT=`) means "not set", so the default applies.
  const defined = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = schema.safeParse(defined);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .sort();
    throw new EnvValidationError(`Invalid environment:\n${problems.join('\n')}`);
  }

  return Object.freeze(result.data);
}
