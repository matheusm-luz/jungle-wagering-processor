import { z } from 'zod';
import { InvalidMoneyError } from '../../domain/errors';
import { Money, type MoneyProps } from '../../domain/money';
import { RequestValidationError } from './request-validation.error';

/**
 * Amount and currency are only typed here; their format is the job of `Money.from`, the single
 * owner of L-02 and L-17.
 */
export const moneySchema = z.strictObject({ amount: z.string(), currency: z.string() });

/**
 * A provider-supplied identifier, stored as `text` with no format: 1 to 128 characters.
 * PostgreSQL cannot store U+0000 in `text`: refused here, or it would be a driver error and a 500.
 */
export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes(String.fromCharCode(0)), 'must not contain U+0000');

/** Internal ids are `uuid` columns: anything else would make PostgreSQL raise 22P02. */
export const uuidSchema = z.uuid();

/** Field paths and reasons only, never the values: they can be financial data. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
    .join('; ');
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RequestValidationError(describeIssues(result.error));
  }
  return result.data;
}

/** `props` as a `Money`; an invalid amount or currency is a 400 on `field`. */
export function money(field: string, props: MoneyProps): Money {
  try {
    return Money.from(props);
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new RequestValidationError(`${field}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * The idempotency key: visible ASCII, 1 to 256 characters (S4 review, m2). Outside that range a
 * header and a JSON field (the SQS `data.idempotencyKey`) may decode to different strings, and the
 * same request would stop being a replay. 256 holds `{providerId}:{externalTransactionId}` of
 * realistic ids; U+0000 is excluded with every other control character.
 */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,256}$/, 'must be 1 to 256 visible ASCII characters');
