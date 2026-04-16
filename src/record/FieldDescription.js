/**
 * Field description factory.
 *
 * Consolidates JTOpen's 15 FieldDescription subclasses into a single class
 * with static factory methods. Each factory creates a FieldDescription that
 * wraps the corresponding AS400DataType converter.
 *
 * Upstream: *FieldDescription.java (15 classes)
 * @module record/FieldDescription
 */

import { AS400Bin1 } from '../datatypes/AS400Bin1.js';
import { AS400Bin2 } from '../datatypes/AS400Bin2.js';
import { AS400Bin4 } from '../datatypes/AS400Bin4.js';
import { AS400Bin8 } from '../datatypes/AS400Bin8.js';
import { AS400UnsignedBin1 } from '../datatypes/AS400UnsignedBin1.js';
import { AS400UnsignedBin2 } from '../datatypes/AS400UnsignedBin2.js';
import { AS400UnsignedBin4 } from '../datatypes/AS400UnsignedBin4.js';
import { AS400Float4 } from '../datatypes/AS400Float4.js';
import { AS400Float8 } from '../datatypes/AS400Float8.js';
import { AS400Text } from '../datatypes/AS400Text.js';
import { AS400PackedDecimal } from '../datatypes/AS400PackedDecimal.js';
import { AS400ZonedDecimal } from '../datatypes/AS400ZonedDecimal.js';
import { AS400ByteArray } from '../datatypes/AS400ByteArray.js';
import { AS400Array } from '../datatypes/AS400Array.js';
import { AS400Date } from '../datatypes/datetime/AS400Date.js';
import { AS400Time } from '../datatypes/datetime/AS400Time.js';
import { AS400Timestamp } from '../datatypes/datetime/AS400Timestamp.js';

/** Field type constants. */
export const FIELD_TYPE = Object.freeze({
  BINARY:        'binary',
  CHARACTER:     'character',
  PACKED:        'packed',
  ZONED:         'zoned',
  FLOAT:         'float',
  HEX:           'hex',
  DATE:          'date',
  TIME:          'time',
  TIMESTAMP:     'timestamp',
  DBCS_EITHER:   'dbcsEither',
  DBCS_GRAPHIC:  'dbcsGraphic',
  DBCS_ONLY:     'dbcsOnly',
  DBCS_OPEN:     'dbcsOpen',
  ARRAY:         'array',
});

export class FieldDescription {
  /** @type {string} Field name */
  #name;
  /** @type {string} Field type constant */
  #fieldType;
  /** @type {import('../datatypes/AS400DataType.js').AS400DataType} */
  #dataType;
  /** @type {number} Byte length on wire */
  #byteLength;
  /** @type {number} CCSID for text fields */
  #ccsid;
  /** @type {boolean} Whether this field allows null */
  #allowNull;
  /** @type {*} Default value */
  #defaultValue;
  /** @type {string} Text description / DDS text */
  #text;
  /** @type {string} Alias name */
  #alias;
  /** @type {number} Number of digits (for decimal types) */
  #digits;
  /** @type {number} Number of decimal positions */
  #decimalPositions;
  /** @type {string} Date/time format */
  #format;
  /** @type {number} Array element count (for array type) */
  #arrayCount;

  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} opts.fieldType
   * @param {import('../datatypes/AS400DataType.js').AS400DataType} opts.dataType
   * @param {number} [opts.ccsid=0]
   * @param {boolean} [opts.allowNull=false]
   * @param {*} [opts.defaultValue]
   * @param {string} [opts.text='']
   * @param {string} [opts.alias='']
   * @param {number} [opts.digits=0]
   * @param {number} [opts.decimalPositions=0]
   * @param {string} [opts.format='']
   * @param {number} [opts.arrayCount=0]
   */
  constructor(opts) {
    this.#name = opts.name;
    this.#fieldType = opts.fieldType;
    this.#dataType = opts.dataType;
    this.#byteLength = opts.dataType.byteLength();
    this.#ccsid = opts.ccsid ?? 0;
    this.#allowNull = opts.allowNull ?? false;
    this.#defaultValue = opts.defaultValue;
    this.#text = opts.text ?? '';
    this.#alias = opts.alias ?? '';
    this.#digits = opts.digits ?? 0;
    this.#decimalPositions = opts.decimalPositions ?? 0;
    this.#format = opts.format ?? '';
    this.#arrayCount = opts.arrayCount ?? 0;
  }

  get name() { return this.#name; }
  get fieldType() { return this.#fieldType; }
  get dataType() { return this.#dataType; }
  get byteLength() { return this.#byteLength; }
  get ccsid() { return this.#ccsid; }
  get allowNull() { return this.#allowNull; }
  get defaultValue() { return this.#defaultValue; }
  get text() { return this.#text; }
  get alias() { return this.#alias; }
  get digits() { return this.#digits; }
  get decimalPositions() { return this.#decimalPositions; }
  get format() { return this.#format; }
  get arrayCount() { return this.#arrayCount; }

  set allowNull(v) { this.#allowNull = !!v; }
  set defaultValue(v) { this.#defaultValue = v; }
  set text(v) { this.#text = v ?? ''; }
  set alias(v) { this.#alias = v ?? ''; }

  /**
   * Binary field (1, 2, 4, or 8 byte integer).
   * @param {string} name
   * @param {number} length - Byte length: 1, 2, 4, or 8
   * @param {object} [opts]
   * @param {boolean} [opts.unsigned=false]
   * @returns {FieldDescription}
   */
  static binary(name, length, opts = {}) {
    let dataType;
    if (opts.unsigned) {
      switch (length) {
        case 1: dataType = new AS400UnsignedBin1(); break;
        case 2: dataType = new AS400UnsignedBin2(); break;
        case 4: dataType = new AS400UnsignedBin4(); break;
        default: dataType = new AS400UnsignedBin4(); break;
      }
    } else {
      switch (length) {
        case 1: dataType = new AS400Bin1(); break;
        case 2: dataType = new AS400Bin2(); break;
        case 8: dataType = new AS400Bin8(); break;
        case 4: default: dataType = new AS400Bin4(); break;
      }
    }
    return new FieldDescription({
      name, fieldType: FIELD_TYPE.BINARY, dataType, ...opts,
    });
  }

  /**
   * Character (text) field.
   * @param {string} name
   * @param {number} length - Byte length
   * @param {number} [ccsid=37]
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static character(name, length, ccsid = 37, opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.CHARACTER,
      dataType: new AS400Text(length, ccsid),
      ccsid,
      ...opts,
    });
  }

  /**
   * Packed decimal field.
   * @param {string} name
   * @param {number} digits - Total number of digits
   * @param {number} decimals - Number of decimal positions
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static packedDecimal(name, digits, decimals, opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.PACKED,
      dataType: new AS400PackedDecimal(digits, decimals),
      digits,
      decimalPositions: decimals,
      ...opts,
    });
  }

  /**
   * Zoned decimal field.
   * @param {string} name
   * @param {number} digits - Total number of digits
   * @param {number} decimals - Number of decimal positions
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static zonedDecimal(name, digits, decimals, opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.ZONED,
      dataType: new AS400ZonedDecimal(digits, decimals),
      digits,
      decimalPositions: decimals,
      ...opts,
    });
  }

  /**
   * Float field (4 or 8 byte IEEE float).
   * @param {string} name
   * @param {number} length - 4 or 8
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static float(name, length, opts = {}) {
    const dataType = length === 8 ? new AS400Float8() : new AS400Float4();
    return new FieldDescription({
      name, fieldType: FIELD_TYPE.FLOAT, dataType, ...opts,
    });
  }

  /**
   * Hex (raw binary) field.
   * @param {string} name
   * @param {number} length - Byte length
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static hex(name, length, opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.HEX,
      dataType: new AS400ByteArray(length),
      ...opts,
    });
  }

  /**
   * Date field.
   * @param {string} name
   * @param {string} [format='*ISO']
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static date(name, format = '*ISO', opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.DATE,
      dataType: new AS400Date(format),
      format,
      ...opts,
    });
  }

  /**
   * Time field.
   * @param {string} name
   * @param {string} [format='*ISO']
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static time(name, format = '*ISO', opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.TIME,
      dataType: new AS400Time(format),
      format,
      ...opts,
    });
  }

  /**
   * Timestamp field.
   * @param {string} name
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static timestamp(name, opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.TIMESTAMP,
      dataType: new AS400Timestamp(),
      ...opts,
    });
  }

  /**
   * DBCS-Either field (mixed single/double-byte).
   * @param {string} name
   * @param {number} length
   * @param {number} [ccsid=37]
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static dbcsEither(name, length, ccsid = 37, opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.DBCS_EITHER,
      dataType: new AS400Text(length, ccsid),
      ccsid,
      ...opts,
    });
  }

  /**
   * DBCS-Graphic field (double-byte only, graphic CCSID).
   * @param {string} name
   * @param {number} length
   * @param {number} [ccsid=13488]
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static dbcsGraphic(name, length, ccsid = 13488, opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.DBCS_GRAPHIC,
      dataType: new AS400Text(length, ccsid),
      ccsid,
      ...opts,
    });
  }

  /**
   * DBCS-Only field.
   * @param {string} name
   * @param {number} length
   * @param {number} [ccsid=37]
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static dbcsOnly(name, length, ccsid = 37, opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.DBCS_ONLY,
      dataType: new AS400Text(length, ccsid),
      ccsid,
      ...opts,
    });
  }

  /**
   * DBCS-Open field.
   * @param {string} name
   * @param {number} length
   * @param {number} [ccsid=37]
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static dbcsOpen(name, length, ccsid = 37, opts = {}) {
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.DBCS_OPEN,
      dataType: new AS400Text(length, ccsid),
      ccsid,
      ...opts,
    });
  }

  /**
   * Array field.
   * @param {string} name
   * @param {FieldDescription} elementDesc - Element field description
   * @param {number} count - Number of elements
   * @param {object} [opts]
   * @returns {FieldDescription}
   */
  static array(name, elementDesc, count, opts = {}) {
    const dataType = new AS400Array(elementDesc.dataType, count);
    return new FieldDescription({
      name,
      fieldType: FIELD_TYPE.ARRAY,
      dataType,
      arrayCount: count,
      ...opts,
    });
  }
}
