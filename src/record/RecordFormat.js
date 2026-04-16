/**
 * Record format descriptor.
 *
 * Holds an ordered collection of FieldDescriptions that define the layout
 * of a physical file record. Computes field offsets and total record length.
 *
 * Upstream: RecordFormat.java
 * @module record/RecordFormat
 */

export class RecordFormat {
  /** @type {string} Format name (e.g. record format name from DDS) */
  #name;
  /** @type {import('./FieldDescription.js').FieldDescription[]} */
  #fields = [];
  /** @type {Map<string, number>} Field name → index */
  #nameIndex = new Map();
  /** @type {number[]} Byte offset of each field within the record */
  #offsets = [];
  /** @type {number} Total record length in bytes */
  #recordLength = 0;
  /** @type {string[]} Key field names (for keyed files) */
  #keyFields = [];
  /** @type {boolean} Whether this format has null-capable fields */
  #hasNullFields = false;

  /**
   * @param {string} [name=''] - Record format name
   */
  constructor(name = '') {
    this.#name = name;
  }

  get name() { return this.#name; }
  set name(v) { this.#name = v; }

  get recordLength() { return this.#recordLength; }

  get numberOfFields() { return this.#fields.length; }

  get hasNullFields() { return this.#hasNullFields; }

  /**
   * Add a field description to this format.
   * @param {import('./FieldDescription.js').FieldDescription} field
   */
  addFieldDescription(field) {
    const idx = this.#fields.length;
    this.#fields.push(field);
    this.#nameIndex.set(field.name.toUpperCase(), idx);
    this.#offsets.push(this.#recordLength);
    this.#recordLength += field.byteLength;
    if (field.allowNull) this.#hasNullFields = true;
  }

  /**
   * Get a field description by name.
   * @param {string} name
   * @returns {import('./FieldDescription.js').FieldDescription}
   */
  getFieldDescription(name) {
    const idx = this.#nameIndex.get(name.toUpperCase());
    if (idx === undefined) {
      throw new Error(`Field '${name}' not found in record format '${this.#name}'`);
    }
    return this.#fields[idx];
  }

  /**
   * Get a field description by index.
   * @param {number} index
   * @returns {import('./FieldDescription.js').FieldDescription}
   */
  getFieldDescriptionByIndex(index) {
    if (index < 0 || index >= this.#fields.length) {
      throw new Error(`Field index ${index} out of range (0-${this.#fields.length - 1})`);
    }
    return this.#fields[index];
  }

  /**
   * Get the byte offset of a field within the record buffer.
   * @param {string} name
   * @returns {number}
   */
  getFieldOffset(name) {
    const idx = this.#nameIndex.get(name.toUpperCase());
    if (idx === undefined) {
      throw new Error(`Field '${name}' not found in record format '${this.#name}'`);
    }
    return this.#offsets[idx];
  }

  /**
   * Get the byte offset by field index.
   * @param {number} index
   * @returns {number}
   */
  getFieldOffsetByIndex(index) {
    if (index < 0 || index >= this.#fields.length) {
      throw new Error(`Field index ${index} out of range`);
    }
    return this.#offsets[index];
  }

  /**
   * Get the index of a field by name.
   * @param {string} name
   * @returns {number}
   */
  getFieldIndex(name) {
    const idx = this.#nameIndex.get(name.toUpperCase());
    if (idx === undefined) return -1;
    return idx;
  }

  /**
   * Get all field names in order.
   * @returns {string[]}
   */
  getFieldNames() {
    return this.#fields.map(f => f.name);
  }

  /**
   * Get all field descriptions in order.
   * @returns {import('./FieldDescription.js').FieldDescription[]}
   */
  getFieldDescriptions() {
    return [...this.#fields];
  }

  /**
   * Set the key field names for keyed file access.
   * @param {string[]} keyFieldNames
   */
  setKeyFieldNames(keyFieldNames) {
    this.#keyFields = keyFieldNames.map(n => n.toUpperCase());
  }

  /**
   * Get the key field names.
   * @returns {string[]}
   */
  getKeyFieldNames() {
    return [...this.#keyFields];
  }

  /**
   * Get the total byte length of all key fields.
   * @returns {number}
   */
  getKeyLength() {
    let len = 0;
    for (const name of this.#keyFields) {
      const idx = this.#nameIndex.get(name);
      if (idx !== undefined) {
        len += this.#fields[idx].byteLength;
      }
    }
    return len;
  }

  /**
   * Check whether a field exists.
   * @param {string} name
   * @returns {boolean}
   */
  hasField(name) {
    return this.#nameIndex.has(name.toUpperCase());
  }
}
