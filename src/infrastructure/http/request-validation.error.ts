/** An invalid request: shape, closed field list, `Money` format. Answered 400, nothing persisted. */
export class RequestValidationError extends Error {
  readonly code: string = 'VALIDATION_ERROR';
  override readonly name: string = 'RequestValidationError';
}

/** R-46: `POST /wagering/transactions` without its `Idempotency-Key` header. Answered 400. */
export class IdempotencyKeyRequiredError extends RequestValidationError {
  override readonly code = 'IDEMPOTENCY_KEY_REQUIRED';
  override readonly name = 'IdempotencyKeyRequiredError';

  constructor() {
    super('The Idempotency-Key header is required');
  }
}
