import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/failure-code';

describe('FailureCode', () => {
  // The codes are a contract with providers: renaming one is a breaking change.
  test('lists exactly the persisted codes of ARCHITECTURE §6', () => {
    const codes: string[] = Object.values(FailureCode);

    expect(codes.sort()).toEqual([
      'CURRENCY_MISMATCH',
      'INSUFFICIENT_FUNDS',
      'PROCESSING_FAILED',
      'REFERENCE_ALREADY_REVERSED',
      'REFERENCE_AMOUNT_MISMATCH',
      'REFERENCE_KIND_NOT_ALLOWED',
      'REFERENCE_MISMATCH',
      'REFERENCE_NOT_FOUND',
      'REFERENCE_NOT_PROCESSED',
      'REVERSAL_WOULD_OVERDRAW',
      'WALLET_PLAYER_MISMATCH',
    ]);
  });
});
