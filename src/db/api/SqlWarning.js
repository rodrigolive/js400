/**
 * SQLWarning — non-fatal diagnostic chain for Connections/Statements/ResultSets.
 *
 * Mirrors java.sql.SQLWarning: warnings extend SQLException but are non-fatal;
 * they chain through `getNextWarning()`.
 *
 * Upstream: java.sql.SQLWarning (IBM toolbox returns these via
 *   AS400JDBCConnectionImpl.postWarning / postWarningToResultSet etc.)
 * @module db/api/SqlWarning
 */

export class SqlWarning {
  #message;
  #sqlState;
  #vendorCode;
  #next;

  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.sqlState='01000']
   * @param {number} [opts.vendorCode=0]
   */
  constructor(message, opts = {}) {
    this.#message = String(message ?? '');
    this.#sqlState = opts.sqlState ?? '01000';
    this.#vendorCode = opts.vendorCode ?? 0;
    this.#next = null;
  }

  get message() { return this.#message; }
  get sqlState() { return this.#sqlState; }
  get vendorCode() { return this.#vendorCode; }

  /** @returns {SqlWarning|null} next warning in the chain */
  getNextWarning() { return this.#next; }

  /**
   * Append another warning at the tail of this chain.
   * @param {SqlWarning} w
   */
  setNextWarning(w) {
    let cur = this;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const n = cur.#next;
      if (!n) { cur.#next = w; return; }
      cur = n;
    }
  }

  /** Iterate this chain (including self). */
  *[Symbol.iterator]() {
    let cur = this;
    while (cur) {
      yield cur;
      cur = cur.#next;
    }
  }

  toString() {
    return `SQLWarning: ${this.#sqlState} ${this.#message}`;
  }
}

/**
 * Build a SqlWarning from a parsed SQLCA reply fragment. Returns
 * `null` when the SQLCA does NOT carry a warning, so the caller can
 * inline this on the fast path without branching:
 *
 *   const w = warningFromSqlca(result.sqlca);
 *   if (w) this.#appendWarning(w);
 *
 * A warning is any `sqlCode > 0` other than 100 (end-of-data, not a
 * warning), or any non-zero byte in the 11-byte sqlwarn array.
 *
 * @param {object|null|undefined} sqlca
 * @returns {SqlWarning|null}
 */
export function warningFromSqlca(sqlca) {
  if (!sqlca) return null;
  const code = sqlca.sqlCode | 0;
  const isCodeWarning = code > 0 && code !== 100;
  let anyBit = false;
  if (!isCodeWarning && Array.isArray(sqlca.sqlwarn)) {
    for (let i = 0; i < sqlca.sqlwarn.length; i++) {
      if (sqlca.sqlwarn[i]) { anyBit = true; break; }
    }
  }
  if (!isCodeWarning && !anyBit) return null;
  const msg = sqlca.messageTokens || `SQLCODE ${code}`;
  return new SqlWarning(msg, {
    sqlState: sqlca.sqlState || '01000',
    vendorCode: code,
  });
}
