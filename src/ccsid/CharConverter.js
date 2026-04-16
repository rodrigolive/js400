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

  static isSupported(ccsid) {
    return SPECIAL_CCSIDS[ccsid] !== undefined || ccsidRegistry.has(ccsid);
  }

  static clearCache() {
    converterCache.clear();
  }
}
