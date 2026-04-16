/**
 * CCSID converter factory and registry access.
 *
 * Provides high-level API for converting between Unicode strings
 * and EBCDIC byte arrays using CCSID-specific conversion tables.
 *
 * Upstream: CharConverter.java
 * @module ccsid/CharConverter
 */

import { ConvTable, ConvTableUtf8, ConvTableUtf16, ConvTableBinary } from './ConvTable.js';
import { ccsidRegistry } from './registry.js';

// Cache of instantiated converters
const converterCache = new Map();

// Built-in special converters
const SPECIAL_CCSIDS = {
  1208: () => new ConvTableUtf8(),
  1200: () => new ConvTableUtf16(1200),
  13488: () => new ConvTableUtf16(13488),
  61952: () => new ConvTableUtf16(61952),
  65535: () => new ConvTableBinary(),
};

function getOrCreateConverter(ccsid) {
  if (converterCache.has(ccsid)) {
    return converterCache.get(ccsid);
  }

  let conv;

  // Check special built-in converters
  if (SPECIAL_CCSIDS[ccsid]) {
    conv = SPECIAL_CCSIDS[ccsid]();
  } else {
    // Look up in registry (populated from generated tables)
    const tableData = ccsidRegistry.get(ccsid);
    if (!tableData) {
      throw new Error(`CCSID ${ccsid} not found in registry`);
    }

    if (tableData.type === 'single') {
      conv = new ConvTable(ccsid, tableData.toUnicode, tableData.fromUnicode);
    } else if (tableData.type === 'mixed') {
      // For mixed tables, fall back to the single-byte component
      const sbData = ccsidRegistry.get(tableData.sbCcsid);
      if (sbData) {
        conv = new ConvTable(ccsid, sbData.toUnicode, sbData.fromUnicode);
      } else {
        throw new Error(`CCSID ${ccsid}: single-byte component ${tableData.sbCcsid} not found`);
      }
    } else {
      throw new Error(`CCSID ${ccsid}: unsupported table type '${tableData.type}'`);
    }
  }

  converterCache.set(ccsid, conv);
  return conv;
}

export class CharConverter {
  #ccsid;
  #converter;

  constructor(ccsid) {
    this.#ccsid = ccsid;
    this.#converter = getOrCreateConverter(ccsid);
  }

  get ccsid() { return this.#ccsid; }

  byteArrayToString(buf, offset = 0, length) {
    return this.#converter.byteArrayToString(buf, offset, length);
  }

  stringToByteArray(str) {
    return this.#converter.stringToByteArray(str);
  }

  static byteArrayToString(buf, offset, length, ccsid) {
    const conv = getOrCreateConverter(ccsid);
    return conv.byteArrayToString(buf, offset, length);
  }

  static stringToByteArray(str, ccsid) {
    const conv = getOrCreateConverter(ccsid);
    return conv.stringToByteArray(str);
  }

  /**
   * Resolve (and cache) the underlying ConvTable for a CCSID.
   *
   * Exposed so hot paths (SQL batch encoding) can pre-resolve the
   * converter per column once, avoiding a Map lookup and branch cascade
   * on every field of every row. The returned object has a
   * `fromUnicodeTable` getter for single-byte EBCDIC CCSIDs, which is
   * the common case on IBM i (CCSID 37, 500, 280, etc.).
   */
  static getConverter(ccsid) {
    return getOrCreateConverter(ccsid);
  }

  /**
   * Encode up to `maxLen` bytes of `str` directly into `dest` at
   * `destOffset` without an intermediate Buffer. Returns bytes written.
   * For single-byte EBCDIC this is a 1-to-1 char-to-byte mapping; for
   * UTF-8 we delegate to Buffer.write; for UTF-16 we emit 2 bytes per
   * char. Unused bytes at the tail are NOT zeroed — the caller must
   * pad if needed.
   */
  static stringToByteArrayInto(str, dest, destOffset, maxLen, ccsid) {
    if (ccsid === 1208) {
      return dest.write(str, destOffset, maxLen, 'utf8');
    }
    if (ccsid === 1200 || ccsid === 13488 || ccsid === 61952) {
      const maxChars = maxLen >> 1;
      const n = str.length < maxChars ? str.length : maxChars;
      for (let i = 0; i < n; i++) {
        const code = str.charCodeAt(i);
        dest[destOffset + i * 2] = (code >> 8) & 0xFF;
        dest[destOffset + i * 2 + 1] = code & 0xFF;
      }
      return n * 2;
    }
    if (ccsid === 65535) {
      const n = str.length < maxLen ? str.length : maxLen;
      for (let i = 0; i < n; i++) {
        dest[destOffset + i] = str.charCodeAt(i) & 0xFF;
      }
      return n;
    }
    const conv = getOrCreateConverter(ccsid);
    return conv.stringToByteArrayInto(str, dest, destOffset, maxLen);
  }

  static isSupported(ccsid) {
    return SPECIAL_CCSIDS[ccsid] !== undefined || ccsidRegistry.has(ccsid);
  }

  static clearCache() {
    converterCache.clear();
  }
}
