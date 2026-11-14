/**
 * Outcomes that are never persisted (ARCHITECTURE §6): the request is answered and nothing is
 * written. Each carries its stable code; the HTTP layer picks the status.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Statement §9: a second wallet for the same player and currency is a conflict. */
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor() {
    super('A wallet already exists for this player and currency');
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor() {
    super('Wallet not found');
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor() {
    super('Transaction not found');
  }
}

/** ADR-08: the authenticated caller may not act for the request's `providerId`. */
export class ProviderForbiddenError extends ApplicationError {
  readonly code = 'PROVIDER_FORBIDDEN';

  constructor() {
    super('The caller may not act for this provider');
  }
}

/** ADR-03: the same key with another payload is a conflict, never a replay. */
export class IdempotencyKeyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor() {
    super('The idempotency key was already used with another payload');
  }
}

/** L-04: the provider's external id is a second identity, unique per provider. */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';

  constructor() {
    super('The external transaction id was already used under another idempotency key');
  }
}

/** ADR-05: the same queue message id with another payload. Never applied; dead-lettered. */
export class InboxMessageConflictError extends ApplicationError {
  readonly code = 'INBOX_MESSAGE_CONFLICT';

  constructor() {
    super('The message id was already processed with another payload');
  }
}

/** A request the domain refuses on its own (L-03, L-18), such as a `BET` of zero: answered 400. */
export class InvalidWagerTransactionError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';
}
