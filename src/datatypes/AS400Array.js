/**
 * Homogeneous array composite data type.
 *
 * Wraps a single AS400DataType element type and encodes/decodes
 * arrays of values of that type.
 *
 * Upstream: AS400Array.java
 * @module datatypes/AS400Array
 */

import { AS400DataType, TYPE_ARRAY } from './AS400DataType.js';

export class AS400Array extends AS400DataType {
  #elementType;
  #count;

  constructor(elementType, count) {
    super();
    if (!elementType || !(elementType instanceof AS400DataType)) {
      throw new Error('AS400Array requires an AS400DataType element type');
    }
    if (typeof count !== 'number' || count < 0) {
      throw new Error('AS400Array requires a non-negative count');
    }
    this.#elementType = elementType;
    this.#count = count;
  }

  get typeId() { return TYPE_ARRAY; }

  get elementType() { return this.#elementType; }
  get count() { return this.#count; }

  byteLength() {
    return this.#elementType.byteLength() * this.#count;
  }

  toBuffer(values) {
    if (!Array.isArray(values)) {
      throw new Error('AS400Array.toBuffer() requires an array');
    }
    const elemLen = this.#elementType.byteLength();
    const buf = Buffer.alloc(elemLen * this.#count);

    for (let i = 0; i < this.#count && i < values.length; i++) {
      const encoded = this.#elementType.toBuffer(values[i]);
      encoded.copy(buf, i * elemLen);
    }

    return buf;
  }

  fromBuffer(buf, offset = 0) {
    const elemLen = this.#elementType.byteLength();
    const result = [];

    for (let i = 0; i < this.#count; i++) {
      result.push(this.#elementType.fromBuffer(buf, offset + i * elemLen));
    }

    return result;
  }
}
