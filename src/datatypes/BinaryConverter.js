/**
 * Low-level binary conversion helpers.
 *
 * Upstream: BinaryConverter.java
 * @module datatypes/BinaryConverter
 */

const scratch = new ArrayBuffer(8);
const scratchView = new DataView(scratch);

export class BinaryConverter {
  static intToByteArray(value, buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setInt32(offset, value);
  }

  static byteArrayToInt(buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return view.getInt32(offset);
  }

  static shortToByteArray(value, buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setInt16(offset, value);
  }

  static byteArrayToShort(buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return view.getInt16(offset);
  }

  static longToByteArray(value, buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setBigInt64(offset, BigInt(value));
  }

  static byteArrayToLong(buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return view.getBigInt64(offset);
  }

  static unsignedShortToByteArray(value, buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setUint16(offset, value);
  }

  static byteArrayToUnsignedShort(buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return view.getUint16(offset);
  }

  static unsignedIntToByteArray(value, buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setUint32(offset, value);
  }

  static byteArrayToUnsignedInt(buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return view.getUint32(offset);
  }

  static floatToByteArray(value, buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setFloat32(offset, value);
  }

  static byteArrayToFloat(buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return view.getFloat32(offset);
  }

  static doubleToByteArray(value, buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setFloat64(offset, value);
  }

  static byteArrayToDouble(buf, offset = 0) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return view.getFloat64(offset);
  }

  static bytesToHex(buf, offset = 0, length) {
    const len = length ?? buf.length - offset;
    let hex = '';
    for (let i = offset; i < offset + len; i++) {
      hex += (buf[i] >>> 0).toString(16).padStart(2, '0').toUpperCase();
    }
    return hex;
  }

  static hexToBytes(hex) {
    const len = hex.length >>> 1;
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return buf;
  }
}
