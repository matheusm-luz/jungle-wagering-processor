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
