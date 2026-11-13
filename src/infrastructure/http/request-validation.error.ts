/** An invalid request: shape, closed field list, `Money` format. Answered 400, nothing persisted. */
export class RequestValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  override readonly name = 'RequestValidationError';
}
