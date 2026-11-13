/** ADR-05: how a transaction waiting for its reference is retried. Every value comes from the environment. */
export interface ReferenceRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Worker attempts before `REFERENCE_NOT_FOUND`; the request's own lookup is not one (S7, Q2). */
  maxAttempts: number;
}

/**
 * The wait after the `attempts`-th failed worker attempt: `min(max, base × 2^(attempts-1))`, or
 * undefined when that attempt was the last one. Counting attempts, not wall-clock time, means a
 * worker outage does not consume the window.
 */
export function delayBeforeNextAttempt(
  policy: ReferenceRetryPolicy,
  attempts: number,
): number | undefined {
  if (attempts >= policy.maxAttempts) return undefined;
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempts - 1));
}
