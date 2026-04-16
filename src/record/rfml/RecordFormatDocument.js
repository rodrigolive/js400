/**
 * RFML (Record Format Markup Language) parser.
 *
 * Parses RFML XML documents to build RecordFormat instances.
 * RFML is the record-level equivalent of PCML, describing physical file
 * record layouts in XML rather than program call interfaces.
 *
 * RFML DTD elements:
 *   <rfml>              Root element
 *     <recordformat>    Defines a record format (name, description)
 *       <data>          Defines a field (name, type, length, ccsid, etc.)
 *
 * Supported data types in RFML:
 *   char     → AS400Text
 *   int      → AS400Bin2/Bin4/Bin8 (by length)
 *   packed   → AS400PackedDecimal
 *   zoned    → AS400ZonedDecimal
 *   float    → AS400Float4/Float8 (by length)
 *   byte     → AS400ByteArray
 *   struct   → nested structure (inline)
 *
 * Reuses the existing PCML XML parser for XML parsing.
 *
 * Upstream: RecordFormatDocument.java
 * @module record/rfml/RecordFormatDocument
 */

import { parseXml } from '../../pcml/xml.js';
import { RecordFormat } from '../RecordFormat.js';
import { FieldDescription } from '../FieldDescription.js';
import { readFileSync } from 'node:fs';

export class RecordFormatDocument {
  /** @type {Map<string, RecordFormat>} Format name → RecordFormat */
  #formats = new Map();

  /**
   * @param {string|Buffer|Map<string, RecordFormat>} source -
   *   XML string/buffer, or pre-built Map of formats
   */
  constructor(source) {
    if (source instanceof Map) {
      this.#formats = source;
    } else {
      this.#formats = RecordFormatDocument.#parseRFML(source);
    }
  }

  /**
   * Create a RecordFormatDocument from an RFML XML string or Buffer.
   * @param {string|Buffer} source
   * @returns {RecordFormatDocument}
   */
  static fromSource(source) {
    return new RecordFormatDocument(source);
  }

  /**
   * Create a RecordFormatDocument from an RFML file.
   * @param {string} filePath
   * @returns {RecordFormatDocument}
   */
  static fromFile(filePath) {
    const source = readFileSync(filePath, 'utf-8');
    return new RecordFormatDocument(source);
  }

  /**
   * Get a record format by name.
   * @param {string} name
   * @returns {RecordFormat}
   */
  getRecordFormat(name) {
    const fmt = this.#formats.get(name.toUpperCase());
    if (!fmt) {
      throw new Error(`Record format '${name}' not found in RFML document`);
    }
    return fmt;
  }

  /**
   * Get all record format names.
   * @returns {string[]}
   */
  getRecordFormatNames() {
    return [...this.#formats.keys()];
  }

  /**
   * Get the number of record formats in this document.
   * @returns {number}
   */
  get size() {
    return this.#formats.size;
  }

  /**
   * Build all formats as a Map.
   * @returns {Map<string, RecordFormat>}
   */
  getRecordFormats() {
    return new Map(this.#formats);
  }

  // ---- Internal ----

  /**
   * Parse RFML XML into a Map of RecordFormats.
   * @param {string|Buffer} source
   * @returns {Map<string, RecordFormat>}
   */
  static #parseRFML(source) {
    const root = parseXml(source);
    const formats = new Map();

    // Find all <recordformat> elements
    const rfmlRoot = root.tag === 'rfml' ? root : RecordFormatDocument.#findChild(root, 'rfml');
    if (!rfmlRoot) {
      throw new Error('RFML document must have an <rfml> root element');
    }

    for (const child of rfmlRoot.children) {
      if (child.tag === 'recordformat') {
        const format = RecordFormatDocument.#parseRecordFormat(child);
        formats.set(format.name.toUpperCase(), format);
      }
    }

    return formats;
  }

  /**
   * Parse a <recordformat> element into a RecordFormat.
   * @param {import('../../pcml/xml.js').XmlElement} elem
   * @returns {RecordFormat}
   */
  static #parseRecordFormat(elem) {
    const name = elem.attrs.name || '';
    const format = new RecordFormat(name);
    const keyFields = [];

    for (const child of elem.children) {
      if (child.tag === 'data') {
        const fd = RecordFormatDocument.#parseDataElement(child);
        if (fd) {
          format.addFieldDescription(fd);
          if (child.attrs.keyfield === 'true') {
            keyFields.push(fd.name);
          }
        }
      }
    }

    if (keyFields.length > 0) {
      format.setKeyFieldNames(keyFields);
    }

    return format;
  }

  /**
   * Parse a <data> element into a FieldDescription.
   * @param {import('../../pcml/xml.js').XmlElement} elem
   * @returns {FieldDescription|null}
   */
  static #parseDataElement(elem) {
    const attrs = elem.attrs;
    const name = attrs.name || '';
    const type = (attrs.type || 'char').toLowerCase();
    const length = parseInt(attrs.length, 10) || 0;
    const precision = parseInt(attrs.precision, 10) || 0;
    const ccsid = parseInt(attrs.ccsid, 10) || 37;
    const count = parseInt(attrs.count, 10) || 0;

    const opts = {};
    if (attrs.description) opts.text = attrs.description;

    switch (type) {
      case 'char':
        return FieldDescription.character(name, length, ccsid, opts);

      case 'int':
        return FieldDescription.binary(name, length || 4, opts);

      case 'packed':
        return FieldDescription.packedDecimal(name, length, precision, opts);

      case 'zoned':
        return FieldDescription.zonedDecimal(name, length, precision, opts);

      case 'float':
        return FieldDescription.float(name, length || 4, opts);

      case 'byte':
        return FieldDescription.hex(name, length, opts);

      case 'date':
        return FieldDescription.date(name, attrs.dateformat || '*ISO', opts);

      case 'time':
        return FieldDescription.time(name, attrs.timeformat || '*ISO', opts);

      case 'timestamp':
        return FieldDescription.timestamp(name, opts);

      default:
        return FieldDescription.character(name, length, ccsid, opts);
    }
  }

  /**
   * Find a child element by tag name.
   * @param {import('../../pcml/xml.js').XmlElement} elem
   * @param {string} tag
   * @returns {import('../../pcml/xml.js').XmlElement|null}
   */
  static #findChild(elem, tag) {
    for (const child of (elem.children || [])) {
      if (child.tag === tag) return child;
      const found = RecordFormatDocument.#findChild(child, tag);
      if (found) return found;
    }
    return null;
  }
}
