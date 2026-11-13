import { describe, expect, test } from 'bun:test';
import { delayBeforeNextAttempt } from '../../../src/application/reference-retry-policy';

const ADR_05 = { baseDelayMs: 1000, maxDelayMs: 60_000, maxAttempts: 10 };

describe('delayBeforeNextAttempt (ADR-05, docs/tasks/S7.md Q2)', () => {
  test('the delays after attempts 1 to 9 are 1, 2, 4, 8, 16, 32, 60, 60, 60 s and the 10th attempt exhausts', () => {
    const delays = Array.from({ length: 10 }, (_, i) => delayBeforeNextAttempt(ADR_05, i + 1));

    expect(delays).toEqual([
      1000,
      2000,
      4000,
      8000,
      16_000,
      32_000,
      60_000,
      60_000,
      60_000,
      undefined,
    ]);
  });

  test('base, cap and limit come from the configuration', () => {
    const policy = { baseDelayMs: 5, maxDelayMs: 12, maxAttempts: 4 };

    expect([1, 2, 3, 4, 5].map((attempts) => delayBeforeNextAttempt(policy, attempts))).toEqual([
      5,
      10,
      12,
      undefined,
      undefined,
    ]);
  });
});
