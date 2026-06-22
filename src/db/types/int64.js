/**
 * Shared 64-bit integer coercion policy.
 *
 * DB2 BIGINT (and the AS400Bin8 / AS400UnsignedBin8 converters) read int64
 * values as native JS `BigInt`. `BigInt` is not serializable by JSON.stringify
 * or BSON and does not mix with `Number` arithmetic, so by default we narrow to
 * `Number` whenever that is lossless and only keep `BigInt` when the magnitude
 * would lose precision (|value| > 2^53-1).
 *
 * JTOpen returns a Java `Long` here; JS has no `Long`, so this mirrors the
 * pragmatic behavior of node-jt400 / ibm_db / odbc (Number) while avoiding the
 * silent precision loss those drivers suffer above 2^53.
 *
 * @module db/types/int64
 */

/**
 * Coerce a raw int64 `BigInt` to the configured representation.
 *
 * Modes:
 *   'auto'   (default) — Number when it round-trips losslessly, else BigInt
 *   'number'           — always Number (lossy beyond 2^53-1)
 *   'bigint'           — always native BigInt (full precision)
 *   'string'           — always a decimal string
 *
 * Works for both signed (readBigInt64BE) and unsigned (readBigUInt64BE)
 * sources: the caller passes the BigInt, and any value with magnitude >= 2^53
 * fails the round-trip check and stays BigInt under 'auto'. Unknown modes fall
 * through to 'auto' so a bad option can never throw on the decode hot path.
 *
 * @param {bigint} raw - the value read off the wire
 * @param {('auto'|'number'|'bigint'|'string')} [mode='auto']
 * @returns {number|bigint|string}
 */
export function coerceInt64(raw, mode) {
  switch (mode) {
    case 'bigint': return raw;
    case 'number': return Number(raw);
    case 'string': return raw.toString();
    case 'auto':
    default: {
      const n = Number(raw);
      return raw === BigInt(n) ? n : raw;
    }
  }
}

/** Valid `bigintMode` values, shared by property validation and clamping. */
export const BIGINT_MODES = new Set(['auto', 'number', 'bigint', 'string']);

/**
 * Clamp an arbitrary value to a valid bigint mode, defaulting to 'auto'.
 * @param {any} mode
 * @returns {('auto'|'number'|'bigint'|'string')}
 */
export function normalizeBigintMode(mode) {
  return BIGINT_MODES.has(mode) ? mode : 'auto';
}
