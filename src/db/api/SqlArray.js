/**
 * SQL ARRAY type wrapper.
 *
 * Wraps a DB2 ARRAY value as a plain JS array with type metadata.
 *
 * Upstream: AS400JDBCArray.java
 * @module db/api/SqlArray
 */

export class SqlArray {
  #baseType;
  #baseTypeName;
  #elements;

  /**
   * @param {object} opts
   * @param {number} opts.baseType - SQL type code of array elements
   * @param {string} opts.baseTypeName - SQL type name
   * @param {any[]} opts.elements - array values
   */
  constructor(opts = {}) {
    this.#baseType = opts.baseType ?? 0;
    this.#baseTypeName = opts.baseTypeName ?? 'UNKNOWN';
    this.#elements = opts.elements ? [...opts.elements] : [];
  }

  get baseType() { return this.#baseType; }
  get baseTypeName() { return this.#baseTypeName; }

  getArray() {
    return [...this.#elements];
  }

  get length() {
    return this.#elements.length;
  }

  [Symbol.iterator]() {
    return this.#elements[Symbol.iterator]();
  }

  toJSON() {
    return this.#elements;
  }
}
