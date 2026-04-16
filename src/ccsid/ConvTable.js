/**
 * Base converter table.
 *
 * Handles single-byte EBCDIC <-> Unicode conversion using
 * generated lookup tables.
 *
 * Upstream: ConvTable.java, ConvTableSingleMap.java
 * @module ccsid/ConvTable
 */

// Compression markers used in generated fromUnicode data
const CIC = 0xFFFF;  // continue with constant
const RIC = 0xFFFE;  // range with increment
const HBIC = 0x0000; // high-byte increment
const PAD = 0xFEFE;  // padding indicator

export class ConvTable {
  #ccsid;
  #toUnicode;   // Uint16Array(256) for single-byte
  #fromUnicode; // Uint8Array(65536) for single-byte

  constructor(ccsid, toUnicodeHex, fromUnicodeHex) {
    this.#ccsid = ccsid;

    // Parse toUnicode: 256 entries, each 4 hex chars = 1 unicode codepoint
    this.#toUnicode = new Uint16Array(256);
    for (let i = 0; i < 256 && i * 4 < toUnicodeHex.length; i++) {
      this.#toUnicode[i] = parseInt(toUnicodeHex.substring(i * 4, i * 4 + 4), 16);
    }

    // Parse and decompress fromUnicode into a 65536-byte reverse lookup
    this.#fromUnicode = new Uint8Array(65536);
    this.#fromUnicode.fill(0x3F); // default substitution char '?'

    if (fromUnicodeHex && fromUnicodeHex.length > 0) {
      const compressed = [];
      for (let i = 0; i < fromUnicodeHex.length; i += 4) {
        compressed.push(parseInt(fromUnicodeHex.substring(i, i + 4), 16));
      }
      this.#decompressSB(compressed);
    } else {
      // Build reverse map from toUnicode directly
      for (let ebcdic = 0; ebcdic < 256; ebcdic++) {
        const unicode = this.#toUnicode[ebcdic];
        if (unicode !== 0xFFFD && unicode !== 0x001A) {
          this.#fromUnicode[unicode] = ebcdic;
        }
      }
    }
  }

  get ccsid() { return this.#ccsid; }

  /**
   * Expose the from-unicode lookup table as a Uint8Array.
   * Used by the SQL fast path to inline single-byte EBCDIC encoding
   * without going through an additional method call per field.
   */
  get fromUnicodeTable() { return this.#fromUnicode; }

  byteArrayToString(buf, offset = 0, length) {
    const len = length ?? buf.length - offset;
    if (len <= 0) return '';
    const table = this.#toUnicode;

    // Small strings: build via String.fromCharCode.apply on a small array.
    // This is 3-5x faster than `result += String.fromCharCode(...)` per byte,
    // which triggers string rope allocations across each iteration.
    if (len <= 4096) {
      const chars = new Array(len);
      for (let i = 0; i < len; i++) {
        chars[i] = table[buf[offset + i]];
      }
      return String.fromCharCode.apply(null, chars);
    }

    // Longer strings: chunk to stay under argument-count limits.
    let out = '';
    const CHUNK = 4096;
    for (let start = 0; start < len; start += CHUNK) {
      const end = start + CHUNK < len ? start + CHUNK : len;
      const chars = new Array(end - start);
      for (let i = start; i < end; i++) {
        chars[i - start] = table[buf[offset + i]];
      }
      out += String.fromCharCode.apply(null, chars);
    }
    return out;
  }

  stringToByteArray(str) {
    const len = str.length;
    const buf = Buffer.allocUnsafe(len);
    const table = this.#fromUnicode;
    for (let i = 0; i < len; i++) {
      buf[i] = table[str.charCodeAt(i)] || 0x3F;
    }
    return buf;
  }

  /**
   * Encode up to `maxLen` characters of `str` directly into `dest`
   * starting at `destOffset`. Avoids the intermediate buffer
   * allocation/copy of `stringToByteArray`. Returns the number of
   * bytes written.
   *
   * @param {string} str
   * @param {Buffer} dest
   * @param {number} destOffset
   * @param {number} maxLen - max bytes to write (string is truncated)
   * @returns {number} bytes written
   */
  stringToByteArrayInto(str, dest, destOffset, maxLen) {
    const len = str.length < maxLen ? str.length : maxLen;
    const table = this.#fromUnicode;
    for (let i = 0; i < len; i++) {
      dest[destOffset + i] = table[str.charCodeAt(i)] || 0x3F;
    }
    return len;
  }

  #decompressSB(arr) {
    const buf = this.#fromUnicode;
    let c = 0;

    for (let i = 0; i < arr.length; i++) {
      const val = arr[i];

      if (val === CIC) {
        if (i + 1 < arr.length && arr[i + 1] === (PAD & 0xFFFF)) {
          // Literal CIC char
          buf[c++] = (val >> 8) & 0xFF;
          buf[c++] = val & 0xFF;
          i++;
        } else {
          // Repeat: count = arr[i+1], char = arr[i+2]
          const count = arr[i + 1];
          const ch = arr[i + 2];
          const max = count * 2 + c;
          while (c < max && c < buf.length) {
            buf[c++] = (ch >> 8) & 0xFF;
            buf[c++] = ch & 0xFF;
          }
          i += 2;
        }
      } else if (val === RIC) {
        if (i + 1 < arr.length && arr[i + 1] === (PAD & 0xFFFF)) {
          buf[c++] = (val >> 8) & 0xFF;
          buf[c++] = val & 0xFF;
          i++;
        } else {
          const num = arr[i + 1];
          const start = arr[i + 2];
          for (let j = start; j < num + start && c < buf.length; j++) {
            buf[c++] = (j >> 8) & 0xFF;
            buf[c++] = j & 0xFF;
          }
          i += 2;
        }
      } else if (val === HBIC) {
        if (i + 1 < arr.length && arr[i + 1] === (PAD & 0xFFFF)) {
          buf[c++] = (val >> 8) & 0xFF;
          buf[c++] = val & 0xFF;
          i++;
        } else {
          const hbNum = arr[++i];
          const firstChar = arr[++i];
          const highByteMask = firstChar & 0xFF00;
          buf[c++] = (firstChar >> 8) & 0xFF;
          buf[c++] = firstChar & 0xFF;
          i++;
          for (let j = 0; j < hbNum && c < buf.length; j++) {
            const both = arr[i + j];
            const c1 = (highByteMask + ((both >> 8) & 0xFF)) & 0xFFFF;
            const c2 = (highByteMask + (both & 0xFF)) & 0xFFFF;
            buf[c++] = (c1 >> 8) & 0xFF;
            buf[c++] = c1 & 0xFF;
            buf[c++] = (c2 >> 8) & 0xFF;
            buf[c++] = c2 & 0xFF;
          }
          i += hbNum - 1;
        }
      } else {
        // Regular character
        buf[c++] = (val >> 8) & 0xFF;
        buf[c++] = val & 0xFF;
      }
    }

    // Fill remaining with sub char
    for (let i = c; i < buf.length; i++) {
      buf[i] = 0x3F;
    }
  }
}

// Special UTF-8 converter (CCSID 1208)
export class ConvTableUtf8 extends ConvTable {
  constructor() {
    super(1208, '', '');
  }

  byteArrayToString(buf, offset = 0, length) {
    const len = length ?? buf.length - offset;
    return buf.toString('utf8', offset, offset + len);
  }

  stringToByteArray(str) {
    return Buffer.from(str, 'utf8');
  }
}

// Special UTF-16BE converter (CCSID 1200, 13488, 61952)
export class ConvTableUtf16 extends ConvTable {
  #actualCcsid;

  constructor(ccsid = 1200) {
    super(ccsid, '', '');
    this.#actualCcsid = ccsid;
  }

  get ccsid() { return this.#actualCcsid; }

  byteArrayToString(buf, offset = 0, length) {
    const len = length ?? buf.length - offset;
    const charCount = len >> 1;
    if (charCount <= 0) return '';
    if (charCount <= 4096) {
      const chars = new Array(charCount);
      for (let i = 0; i < charCount; i++) {
        const o = offset + (i << 1);
        chars[i] = (buf[o] << 8) | buf[o + 1];
      }
      return String.fromCharCode.apply(null, chars);
    }
    let out = '';
    const CHUNK = 4096;
    for (let start = 0; start < charCount; start += CHUNK) {
      const end = start + CHUNK < charCount ? start + CHUNK : charCount;
      const chars = new Array(end - start);
      for (let i = start; i < end; i++) {
        const o = offset + (i << 1);
        chars[i - start] = (buf[o] << 8) | buf[o + 1];
      }
      out += String.fromCharCode.apply(null, chars);
    }
    return out;
  }

  stringToByteArray(str) {
    const buf = Buffer.allocUnsafe(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      buf[i * 2] = (code >> 8) & 0xFF;
      buf[i * 2 + 1] = code & 0xFF;
    }
    return buf;
  }
}

// Binary pass-through (CCSID 65535)
export class ConvTableBinary extends ConvTable {
  constructor() {
    super(65535, '', '');
  }

  byteArrayToString(buf, offset = 0, length) {
    const len = length ?? buf.length - offset;
    return buf.toString('latin1', offset, offset + len);
  }

  stringToByteArray(str) {
    return Buffer.from(str, 'latin1');
  }
}
