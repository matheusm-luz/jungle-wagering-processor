import { describe, expect, test } from 'bun:test';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../../src/infrastructure/http/ledger-cursor';

const WALLET = '01a1d6a7-e895-735a-9b6f-8d6a80c8b117';
const OTHER = '01a1d6a7-e895-735a-9b6f-8d6a80c8b118';

describe('ledger cursor (L-13)', () => {
  test('round-trips a sequence', () => {
    for (const sequence of [1, 2, 50, 2_147_483_647]) {
      const cursor = encodeLedgerCursor(WALLET, sequence);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeLedgerCursor(cursor, WALLET)).toBe(sequence);
    }
  });

  test('refuses a cursor of another wallet (S8 review, m5)', () => {
    expect(decodeLedgerCursor(encodeLedgerCursor(OTHER, 5), WALLET)).toBeUndefined();
  });

  test('refuses a cursor that is not one of ours', () => {
    const encode = (text: string) => Buffer.from(text).toString('base64url');
    for (const cursor of [
      '',
      'not base64!',
      encode('1'),
      encode(`${WALLET}:0`),
      encode(`${WALLET}:-1`),
      encode(`${WALLET}:1.5`),
      encode(`${WALLET}:01`),
      encode(`${WALLET}:1e3`),
      encode(`${WALLET}: 1`),
      encode(`${WALLET}:2147483648`),
      `${encodeLedgerCursor(WALLET, 5)}=`,
    ]) {
      expect(decodeLedgerCursor(cursor, WALLET)).toBeUndefined();
    }
  });
});
