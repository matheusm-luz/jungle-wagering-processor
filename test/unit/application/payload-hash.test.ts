import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { type PayloadHashFields, payloadHash } from '../../../src/application/payload-hash';
import { Money } from '../../../src/domain/money';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction';

function fields(overrides: Partial<PayloadHashFields> = {}): PayloadHashFields {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    ...overrides,
  };
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('payloadHash', () => {
  test('is 64 lowercase hex', () => {
    expect(payloadHash(fields())).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hashes canonical JSON: sorted keys, no whitespace, every value a string', () => {
    expect(payloadHash(fields())).toBe(
      sha256(
        '{"amount":"25.00","currency":"BRL","externalTransactionId":"transaction-123",' +
          '"gameId":"fortune-chimp","kind":"BET","playerId":"player-1",' +
          '"providerId":"provider-a","roundId":"round-987",' +
          '"walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
      ),
    );
  });

  test('does not depend on the order of the fields', () => {
    const reversed = Object.fromEntries(Object.entries(fields()).reverse()) as PayloadHashFields;

    expect(payloadHash(reversed)).toBe(payloadHash(fields()));
  });

  test('ignores anything outside the closed field list', () => {
    const extra = { ...fields(), idempotencyKey: 'key-1', messageId: 'm-1', occurredAt: 'now' };

    expect(payloadHash(extra)).toBe(payloadHash(fields()));
  });

  test('includes the reference only when present', () => {
    const withReference = fields({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'transaction-100',
    });
    const without = fields({ kind: WagerTransactionKind.Win });

    expect(payloadHash(withReference)).not.toBe(payloadHash(without));
    expect(payloadHash(fields({ referenceExternalTransactionId: undefined }))).toBe(
      payloadHash(fields()),
    );
  });

  test('changes when any business field changes', () => {
    const base = payloadHash(fields());
    const variants: Partial<PayloadHashFields>[] = [
      { providerId: 'provider-b' },
      { externalTransactionId: 'transaction-124' },
      { playerId: 'player-2' },
      { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' },
      { roundId: 'round-988' },
      { gameId: 'other-game' },
      { kind: WagerTransactionKind.Win },
      { money: Money.from({ amount: '25.01', currency: 'BRL' }) },
      { money: Money.from({ amount: '25.00', currency: 'USD' }) },
    ];

    for (const variant of variants) {
      expect(payloadHash(fields(variant))).not.toBe(base);
    }
  });
});
