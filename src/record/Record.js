/**
 * Record buffer and field access.
 *
 * A Record wraps a raw byte buffer and provides field-level get/set
 * using the RecordFormat's field descriptions and their AS400DataType converters.
 *
 * Upstream: Record.java
 * @module record/Record
 */

export class Record {
  /** @type {import('./RecordFormat.js').RecordFormat} */
  #format;
  /** @type {Buffer} Raw record data */
  #buffer;
  /** @type {number} Record number (relative record number in file) */
  #recordNumber = 0;
  /** @type {Set<string>} Fields that are explicitly null */
  #nullFields = new Set();

  /**
   * @param {import('./RecordFormat.js').RecordFormat} format
   * @param {Buffer} [data] - Raw record bytes; allocated if omitted
   */
  constructor(format, data) {
    this.#format = format;
    if (data) {
      this.#buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    } else {
      this.#buffer = Buffer.alloc(format.recordLength);
    }
  }

  get format() { return this.#format; }

  get recordNumber() { return this.#recordNumber; }
  set recordNumber(v) { this.#recordNumber = v; }

  /**
   * Get the raw record buffer.
   * @returns {Buffer}
   */
  getContents() {
    return this.#buffer;
  }

  /**
   * Set the raw record buffer.
   * @param {Buffer} data
   */
  setContents(data) {
    this.#buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  }

  /**
   * Get a field value by name, decoded from the buffer.
   * @param {string} name
   * @returns {*}
   */
  getField(name) {
    if (this.#nullFields.has(name.toUpperCase())) return null;
    const desc = this.#format.getFieldDescription(name);
    const offset = this.#format.getFieldOffset(name);
    return desc.dataType.fromBuffer(this.#buffer, offset);
  }

  /**
   * Set a field value by name, encoding into the buffer.
   * @param {string} name
   * @param {*} value
   */
  setField(name, value) {
    if (value === null && this.#format.getFieldDescription(name).allowNull) {
      this.#nullFields.add(name.toUpperCase());
      return;
    }
    this.#nullFields.delete(name.toUpperCase());
    const desc = this.#format.getFieldDescription(name);
    const offset = this.#format.getFieldOffset(name);
    const encoded = desc.dataType.toBuffer(value);
    encoded.copy(this.#buffer, offset, 0, Math.min(encoded.length, desc.byteLength));
  }

  /**
   * Check whether a field is null.
   * @param {string} name
   * @returns {boolean}
   */
  isFieldNull(name) {
    return this.#nullFields.has(name.toUpperCase());
  }

  /**
   * Set a field to null.
   * @param {string} name
   */
  setFieldNull(name) {
    this.#nullFields.add(name.toUpperCase());
  }

  /**
   * Get the number of fields.
   * @returns {number}
   */
  getNumberOfFields() {
    return this.#format.numberOfFields;
  }

  /**
   * Convert all fields to a plain object.
   * @param {object} [opts]
   * @param {boolean} [opts.trim=true] - Trim string fields
   * @returns {Record<string, *>}
   */
  toObject(opts = {}) {
    const trim = opts.trim !== false;
    const obj = {};
    const names = this.#format.getFieldNames();
    for (const name of names) {
      let val = this.getField(name);
      if (trim && typeof val === 'string') {
        val = val.trimEnd();
      }
      obj[name] = val;
    }
    return obj;
  }

  /**
   * Set fields from a plain object.
   * @param {Record<string, *>} obj
   */
  fromObject(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (this.#format.hasField(key)) {
        this.setField(key, value);
      }
    }
  }

  /**
   * Encode all field values into the buffer and return it.
   * @returns {Buffer}
   */
  toBuffer() {
    return Buffer.from(this.#buffer);
  }

  /**
   * Create a record from a raw buffer.
   * @param {import('./RecordFormat.js').RecordFormat} format
   * @param {Buffer} buf
   * @param {number} [recordNumber=0]
   * @returns {Record}
   */
  static fromBuffer(format, buf, recordNumber = 0) {
    const rec = new Record(format, buf);
    rec.recordNumber = recordNumber;
    return rec;
  }

  /**
   * Get the null-field bitmap for DDM protocol.
   * Each byte in the bitmap corresponds to a field; 0xF1 = null, 0xF0 = not null.
   * @returns {Buffer}
   */
  getNullFieldMap() {
    const count = this.#format.numberOfFields;
    const map = Buffer.alloc(count, 0xF0);
    const names = this.#format.getFieldNames();
    for (let i = 0; i < count; i++) {
      if (this.#nullFields.has(names[i].toUpperCase())) {
        map[i] = 0xF1;
      }
    }
    return map;
  }

  /**
   * Apply a null-field bitmap from the DDM protocol.
   * @param {Buffer} map
   */
  applyNullFieldMap(map) {
    const names = this.#format.getFieldNames();
    for (let i = 0; i < Math.min(map.length, names.length); i++) {
      if (map[i] === 0xF1) {
        this.#nullFields.add(names[i].toUpperCase());
      }
    }
  }
}
