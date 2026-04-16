/**
 * EBCDIC/Unicode text data type.
 *
 * Encodes/decodes fixed-length text using a specified CCSID.
 * Default CCSID is 37 (US English EBCDIC).
 * Shorter strings are padded with EBCDIC space (0x40).
 *
 * Upstream: AS400Text.java
 * @module datatypes/AS400Text
 */

import { AS400DataType, TYPE_TEXT } from './AS400DataType.js';
import { CharConverter } from '../ccsid/CharConverter.js';

const EBCDIC_SPACE = 0x40;

export class AS400Text extends AS400DataType {
  #length;
  #ccsid;
  #converter;

  constructor(length, ccsid = 37) {
    super();
    if (typeof length !== 'number' || length < 0) {
      throw new Error('AS400Text requires a non-negative length');
    }
    this.#length = length;
    this.#ccsid = ccsid;
    this.#converter = new CharConverter(ccsid);
  }

  get typeId() { return TYPE_TEXT; }

  get length() { return this.#length; }
  get ccsid() { return this.#ccsid; }

  byteLength() { return this.#length; }

  toBuffer(value) {
    const str = String(value ?? '');
    const encoded = this.#converter.stringToByteArray(str);
    const buf = Buffer.alloc(this.#length, EBCDIC_SPACE);
    encoded.copy(buf, 0, 0, Math.min(encoded.length, this.#length));
    return buf;
  }

  fromBuffer(buf, offset = 0) {
    return this.#converter.byteArrayToString(buf, offset, this.#length);
  }
}
