/**
 * SQLSTATE classes and codes that mean "try again later" (ADR-05): nothing was committed and the
 * same request may succeed once the database, a lock or a connection is available again.
 * `08` connection, `53` insufficient resources, `57` operator intervention (`57014` is
 * `statement_timeout`), `55P03` `lock_timeout`, `40001`/`40P01` serialization and deadlock,
 * `25P03` `idle_in_transaction_session_timeout`.
 */
const TRANSIENT_SQLSTATE = /^(08|53|57)|^(55P03|40001|40P01|25P03)$/;
const TRANSIENT_SOCKET = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);
/** Errors the `pg` driver and pool raise without a code. */
const TRANSIENT_MESSAGE = /^(timeout exceeded when trying to connect|Connection terminated)/;

/** True when `error`, or its `cause`, is a database failure a retry may get past. */
export function isTransientDatabaseError(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 3; depth++) {
    const { code } = current as { code?: unknown };
    if (typeof code === 'string' && (TRANSIENT_SQLSTATE.test(code) || TRANSIENT_SOCKET.has(code)))
      return true;
    if (TRANSIENT_MESSAGE.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
