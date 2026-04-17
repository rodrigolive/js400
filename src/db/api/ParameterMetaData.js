/**
 * ParameterMetaData — JDBC-parity metadata for prepared statement parameters.
 *
 * Exposes per-parameter type info (sqlType, precision, scale, nullable,
 * signed, class name, etc.) from the server's parameter marker descriptors.
 *
 * Upstream: AS400JDBCParameterMetaData.java
 * @module db/api/ParameterMetaData
 */

import { hostTypeToJdbc, hostTypeToClassName } from './ResultSetMetaData.js';

/** JDBC parameter mode constants. */
export const ParameterMode = Object.freeze({
  unknown: 0,
  in:      1,
  inOut:   2,
  out:     4,
});

/** JDBC parameter nullability constants. */
export const ParameterNullable = Object.freeze({
  noNulls:         0,
  nullable:        1,
  nullableUnknown: 2,
});

/**
 * JDBC ParameterMetaData implementation.
 *
 * Parameter positions are 1-based to match the JDBC contract.
 */
export class ParameterMetaData {
  #descriptors;
  #modes;

  /**
   * @param {object[]} descriptors - parameter descriptors from prepare/describe
   * @param {number[]} [modes] - optional per-param modes (ParameterMode.*)
   */
  constructor(descriptors, modes) {
    this.#descriptors = Array.isArray(descriptors) ? descriptors : [];
    this.#modes = Array.isArray(modes) ? modes : null;
  }

  /** @returns {number} parameter count */
  getParameterCount() {
    return this.#descriptors.length;
  }

  /** @returns {object[]} a copy of the underlying descriptor list */
  getDescriptors() {
    return this.#descriptors.slice();
  }

  // --- Per-parameter accessors ---

  isNullable(param) {
    return this.#desc(param).nullable
      ? ParameterNullable.nullable
      : ParameterNullable.noNulls;
  }

  isSigned(param) {
    const abs = Math.abs(this.#desc(param).sqlType) & 0xFFFE;
    return abs === 500 || abs === 496 || abs === 492
        || abs === 480 || abs === 484 || abs === 488
        || abs === 996;
  }

  getPrecision(param) {
    const d = this.#desc(param);
    return d.precision ?? d.length ?? 0;
  }

  getScale(param) {
    return this.#desc(param).scale ?? 0;
  }

  getParameterType(param) {
    return hostTypeToJdbc(this.#desc(param).sqlType);
  }

  getParameterTypeName(param) {
    return this.#desc(param).typeName || '';
  }

  getHostSqlType(param) {
    return this.#desc(param).sqlType;
  }

  getCCSID(param) {
    return this.#desc(param).ccsid ?? 0;
  }

  getParameterClassName(param) {
    return hostTypeToClassName(this.#desc(param).sqlType);
  }

  getParameterMode(param) {
    if (!this.#modes) return ParameterMode.in;
    const idx = Number(param) - 1;
    const m = this.#modes[idx];
    return m == null ? ParameterMode.in : m;
  }

  /** Set (or change) the mode of a specific parameter. */
  setParameterMode(param, mode) {
    if (!this.#modes) {
      this.#modes = new Array(this.#descriptors.length).fill(ParameterMode.in);
    }
    const idx = Number(param) - 1;
    if (idx < 0 || idx >= this.#descriptors.length) {
      throw new RangeError(
        `Parameter index out of range: ${param} (expected 1..${this.#descriptors.length})`,
      );
    }
    this.#modes[idx] = mode;
  }

  /** Plain-object projection for legacy callers. */
  toPlainArray() {
    return this.#descriptors.map((d, i) => ({
      index:     i + 1,
      sqlType:   d.sqlType,
      typeName:  d.typeName,
      jdbcType:  hostTypeToJdbc(d.sqlType),
      className: hostTypeToClassName(d.sqlType),
      precision: d.precision ?? 0,
      scale:     d.scale ?? 0,
      ccsid:     d.ccsid ?? 0,
      nullable:  Boolean(d.nullable),
      mode:      this.#modes ? (this.#modes[i] ?? ParameterMode.in) : ParameterMode.in,
    }));
  }

  /** Retrieve a descriptor by 1-based parameter position. */
  #desc(param) {
    const idx = Number(param) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.#descriptors.length) {
      throw new RangeError(
        `Parameter index out of range: ${param} (expected 1..${this.#descriptors.length})`,
      );
    }
    return this.#descriptors[idx];
  }
}
