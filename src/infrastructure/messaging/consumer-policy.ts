import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  InboxMessageConflictError,
  InvalidWagerTransactionError,
} from '../../application/errors';
import { RequestValidationError } from '../http/request-validation.error';

/**
 * Seconds a failed message stays invisible after its `receiveCount`-th receive (ADR-05):
 * `min(max, base × 2^(receiveCount-1))`. Whole seconds: `ChangeMessageVisibility` takes no less.
 */
export function visibilityBackoff(receiveCount: number, baseS: number, maxS: number): number {
  return Math.min(maxS, baseS * 2 ** (receiveCount - 1));
}

/**
 * `permanent`: the message can never be accepted as it is, so retrying only blocks its FIFO group
 * (ADR-05, docs/tasks/S9.md Q1). Everything else is `transient`: an unexpected error is retried
 * and still reaches the DLQ through the redrive policy, so nothing is dropped on a guess.
 */
export function classify(error: unknown): 'permanent' | 'transient' {
  const permanent =
    error instanceof RequestValidationError ||
    error instanceof InvalidWagerTransactionError ||
    error instanceof InboxMessageConflictError ||
    error instanceof IdempotencyKeyConflictError ||
    error instanceof ExternalTransactionConflictError;
  return permanent ? 'permanent' : 'transient';
}
