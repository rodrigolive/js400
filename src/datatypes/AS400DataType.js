/**
 * Base contract for IBM i data type converters.
 *
 * Every concrete data type implements:
 *   byteLength(value?) - returns the on-wire byte size
 *   toBuffer(value)    - encodes a JS value into a Buffer
 *   fromBuffer(buf, offset?) - decodes a value from a Buffer
 *
 * Upstream: AS400DataType.java
 * @module datatypes/AS400DataType
 */

export const TYPE_BIN1        = 0;
export const TYPE_BIN2        = 1;
export const TYPE_BIN4        = 2;
export const TYPE_BIN8        = 3;
export const TYPE_UBIN1       = 4;
export const TYPE_UBIN2       = 5;
export const TYPE_UBIN4       = 6;
export const TYPE_UBIN8       = 7;
export const TYPE_FLOAT4      = 8;
export const TYPE_FLOAT8      = 9;
export const TYPE_PACKED      = 10;
export const TYPE_ZONED       = 11;
export const TYPE_BYTE_ARRAY  = 12;
export const TYPE_TEXT        = 13;
export const TYPE_STRUCTURE   = 14;
export const TYPE_ARRAY       = 15;
export const TYPE_BOOLEAN     = 16;
export const TYPE_VARCHAR     = 17;
export const TYPE_DATE        = 18;
export const TYPE_TIME        = 19;
export const TYPE_TIMESTAMP   = 20;
export const TYPE_DECFLOAT    = 21;

export class AS400DataType {
  get typeId() {
    throw new Error('AS400DataType subclass must override typeId');
  }

  byteLength(_value) {
    throw new Error('AS400DataType subclass must override byteLength()');
  }

  toBuffer(_value) {
    throw new Error('AS400DataType subclass must override toBuffer()');
  }

  fromBuffer(_buf, _offset) {
    throw new Error('AS400DataType subclass must override fromBuffer()');
  }

  toBytes(value) {
    return this.toBuffer(value);
  }

  toObject(buf, offset) {
    return this.fromBuffer(buf, offset);
  }
}
