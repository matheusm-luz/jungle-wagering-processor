/**
 * The ledger cursor (L-13): base64url of `<walletId>:<last sequence returned>`. Opaque to the client,
 * stable because a sequence never changes once written (`UNIQUE (wallet_id, sequence)`, append-only),
 * and bound to its wallet so a cursor of one wallet cannot skip entries of another (S8 review, m5).
 */
export function encodeLedgerCursor(walletId: string, sequence: number): string {
  return Buffer.from(`${walletId}:${sequence}`).toString('base64url');
}

/** `INTEGER` range of `wallet_ledger_entries.sequence`. */
const MAX_SEQUENCE = 2_147_483_647;

/** The sequence, or undefined for anything `encodeLedgerCursor(walletId, …)` cannot have produced. */
export function decodeLedgerCursor(cursor: string, walletId: string): number | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  const text = Buffer.from(cursor, 'base64url').toString();
  const prefix = `${walletId}:`;
  if (!text.startsWith(prefix)) return undefined;
  const digits = text.slice(prefix.length);
  if (!/^[1-9]\d{0,9}$/.test(digits)) return undefined;
  const sequence = Number(digits);
  // One sequence, one spelling: a re-encoding that differs means trailing bits were dropped.
  if (sequence > MAX_SEQUENCE || encodeLedgerCursor(walletId, sequence) !== cursor) {
    return undefined;
  }
  return sequence;
}
