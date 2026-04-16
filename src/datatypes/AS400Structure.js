/**
 * Heterogeneous structure composite data type.
 *
 * Wraps an ordered list of AS400DataType members and
 * encodes/decodes them as a flat concatenated buffer.
 *
 * Upstream: AS400Structure.java
 * @module datatypes/AS400Structure
 */

import { AS400DataType, TYPE_STRUCTURE } from './AS400DataType.js';

export class AS400Structure extends AS400DataType {
  #members;

  constructor(members) {
    super();
    if (!Array.isArray(members) || members.length === 0) {
      throw new Error('AS400Structure requires a non-empty array of AS400DataType members');
    }
    for (const m of members) {
      if (!(m instanceof AS400DataType)) {
        throw new Error('Each member must be an AS400DataType instance');
      }
    }
    this.#members = members;
  }

  get typeId() { return TYPE_STRUCTURE; }

  get members() { return this.#members; }

  byteLength() {
    let total = 0;
    for (const m of this.#members) {
      total += m.byteLength();
    }
    return total;
  }

  toBuffer(values) {
    if (!Array.isArray(values)) {
      throw new Error('AS400Structure.toBuffer() requires an array of values');
    }
    const totalLen = this.byteLength();
    const buf = Buffer.alloc(totalLen);
    let offset = 0;

    for (let i = 0; i < this.#members.length; i++) {
      const member = this.#members[i];
      const val = i < values.length ? values[i] : undefined;
      const encoded = member.toBuffer(val);
      encoded.copy(buf, offset);
      offset += member.byteLength();
    }

    return buf;
  }

  fromBuffer(buf, offset = 0) {
    const result = [];
    let pos = offset;

    for (const member of this.#members) {
      result.push(member.fromBuffer(buf, pos));
      pos += member.byteLength();
    }

    return result;
  }
}
