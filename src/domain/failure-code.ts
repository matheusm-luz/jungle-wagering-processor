/**
 * Why a transaction ended `REJECTED` or `FAILED`. Stored on the transaction row and returned to the
 * provider, so the values are a stable contract (ARCHITECTURE §6).
 *
 * Codes of outcomes that are never persisted (invalid payload, unknown wallet, idempotency
 * conflict, transient failure) belong to the transport layer, not here.
 */
export enum FailureCode {
  /** `BET` larger than the balance. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** A credit would take the balance beyond `NUMERIC(19,2)` (docs/tasks/S4.md, Q1). */
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  /** Reversing a credit would make the balance negative. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** The wallet belongs to another player. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** The reference never arrived within the retry window. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** The reference has another player, wallet, currency or round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** For example a `REFUND` of a `WIN`. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** The reference is `REJECTED` or `FAILED`. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reversal amount differs from the reference. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** The reference already has a processed reversal. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Permanent non-business error on a persisted transaction. */
  ProcessingFailed = 'PROCESSING_FAILED',
}
