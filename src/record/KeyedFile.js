/**
 * Keyed record access.
 *
 * Provides keyed read, write, update, and delete operations on
 * a physical file with key fields. Records are accessed by key value.
 *
 * Upstream: KeyedFile.java, AS400File.java, AS400FileImplRemote.java
 * @module record/KeyedFile
 */

import { AS400Error } from '../core/errors.js';
import { Record } from './Record.js';
import { DDMReq } from './protocol/DDMReq.js';
import { DDMRep } from './protocol/DDMRep.js';
import { DDMPool } from './protocol/DDMPool.js';
import { FileRecordDescription } from './description/FileRecordDescription.js';

/** Key search type constants. */
export const KEY_SEARCH = Object.freeze({
  EQUAL:          0,
  GREATER:        1,
  LESS:           2,
  GREATER_EQUAL:  3,
  LESS_EQUAL:     4,
});

export class KeyedFile {
  /** @type {import('../core/AS400.js').AS400} */
  #system;
  /** @type {string} IFS path to file */
  #path;
  /** @type {import('./RecordFormat.js').RecordFormat|null} */
  #format = null;
  /** @type {import('../transport/Connection.js').Connection|null} */
  #connection = null;
  /** @type {boolean} */
  #isOpen = false;
  /** @type {string} Open mode */
  #openType = '';
  /** @type {number} Blocking factor */
  #blockingFactor = 1;
  /** @type {string} */
  #member = '*FIRST';
  /** @type {number} */
  #commitLock = 0;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - IFS path (e.g. '/QSYS.LIB/MYLIB.LIB/CUSTMAS.FILE')
   */
  constructor(system, path) {
    this.#system = system;
    this.#path = path;
  }

  get system() { return this.#system; }
  get path() { return this.#path; }
  get isOpen() { return this.#isOpen; }
  get format() { return this.#format; }

  /**
   * Set the record format by retrieving it from the server.
   * @returns {Promise<import('./RecordFormat.js').RecordFormat>}
   */
  async setRecordFormat() {
    const { library, file } = KeyedFile.#parsePath(this.#path);
    this.#format = await FileRecordDescription.retrieveRecordFormat(
      this.#system, library, file
    );
    return this.#format;
  }

  /**
   * Set the record format explicitly.
   * @param {import('./RecordFormat.js').RecordFormat} format
   */
  setFormat(format) {
    this.#format = format;
  }

  /**
   * Open the file for the specified access mode.
   * @param {string} openType - 'READ', 'WRITE', 'READWRITE', 'ALL'
   * @param {number} [blockingFactor=1]
   * @param {object} [opts]
   * @param {string} [opts.member='*FIRST']
   * @param {number} [opts.commitLock=0]
   */
  async open(openType, blockingFactor = 1, opts = {}) {
    if (this.#isOpen) {
      throw new AS400Error('File is already open');
    }
    if (!this.#format) {
      throw new AS400Error('Record format must be set before opening');
    }

    this.#openType = openType;
    this.#blockingFactor = blockingFactor;
    this.#member = opts.member ?? '*FIRST';
    this.#commitLock = opts.commitLock ?? 0;

    this.#connection = await DDMPool.ensureConnection(this.#system);

    const { library, file } = KeyedFile.#parsePath(this.#path);
    const req = DDMReq.buildOpen({
      fileName: `${library}/${file}`,
      member: this.#member,
      openType,
      blockingFactor,
      recordFormatName: this.#format.name,
      keyed: true,
      commitLock: this.#commitLock,
    });

    await this.#connection.send(req);
    const reply = await this.#connection.receive();
    const parsed = DDMRep.parseOpen(reply);

    if (!parsed.success) {
      throw new AS400Error(`Failed to open file: ${parsed.messageId}`);
    }

    this.#isOpen = true;
  }

  /**
   * Read a record by exact key match.
   * @param {Buffer} key - Encoded key value
   * @param {object} [opts]
   * @param {boolean} [opts.lock=false]
   * @returns {Promise<Record|null>}
   */
  async read(key, opts = {}) {
    return this.#readByKey(key, KEY_SEARCH.EQUAL, 0, opts);
  }

  /**
   * Read the next record with a key equal to the specified key.
   * @param {Buffer} key
   * @param {object} [opts]
   * @param {boolean} [opts.lock=false]
   * @returns {Promise<Record|null>}
   */
  async readNextEqual(key, opts = {}) {
    return this.#readByKey(key, KEY_SEARCH.EQUAL, 1, opts);
  }

  /**
   * Read the previous record with a key equal to the specified key.
   * @param {Buffer} key
   * @param {object} [opts]
   * @param {boolean} [opts.lock=false]
   * @returns {Promise<Record|null>}
   */
  async readPreviousEqual(key, opts = {}) {
    return this.#readByKey(key, KEY_SEARCH.EQUAL, 2, opts);
  }

  /**
   * Read the first record with a key greater than the specified key.
   * @param {Buffer} key
   * @param {object} [opts]
   * @returns {Promise<Record|null>}
   */
  async readAfter(key, opts = {}) {
    return this.#readByKey(key, KEY_SEARCH.GREATER, 0, opts);
  }

  /**
   * Read the first record with a key less than the specified key.
   * @param {Buffer} key
   * @param {object} [opts]
   * @returns {Promise<Record|null>}
   */
  async readBefore(key, opts = {}) {
    return this.#readByKey(key, KEY_SEARCH.LESS, 0, opts);
  }

  /**
   * Read the next record sequentially (after the current position).
   * @param {object} [opts]
   * @param {boolean} [opts.lock=false]
   * @returns {Promise<Record|null>}
   */
  async readNext(opts = {}) {
    this.#ensureOpen();
    const req = DDMReq.buildGet({
      direction: 1, // next
      recordCount: 1,
      lockRecord: opts.lock ?? false,
    });
    await this.#connection.send(req);
    const reply = await this.#connection.receive();
    return this.#parseReadReply(reply);
  }

  /**
   * Read the previous record sequentially.
   * @param {object} [opts]
   * @param {boolean} [opts.lock=false]
   * @returns {Promise<Record|null>}
   */
  async readPrevious(opts = {}) {
    this.#ensureOpen();
    const req = DDMReq.buildGet({
      direction: 2, // previous
      recordCount: 1,
      lockRecord: opts.lock ?? false,
    });
    await this.#connection.send(req);
    const reply = await this.#connection.receive();
    return this.#parseReadReply(reply);
  }

  /**
   * Position cursor before the first record with the specified key.
   * @param {Buffer} key
   */
  async positionCursorBefore(key) {
    this.#ensureOpen();
    const req = DDMReq.buildGetByKey({
      key,
      searchType: KEY_SEARCH.GREATER_EQUAL,
      direction: 0,
      recordCount: 0,
    });
    await this.#connection.send(req);
    await this.#connection.receive();
  }

  /**
   * Position cursor after the last record with the specified key.
   * @param {Buffer} key
   */
  async positionCursorAfter(key) {
    this.#ensureOpen();
    const req = DDMReq.buildGetByKey({
      key,
      searchType: KEY_SEARCH.LESS_EQUAL,
      direction: 0,
      recordCount: 0,
    });
    await this.#connection.send(req);
    await this.#connection.receive();
  }

  /**
   * Read all records as an async iterable (in key order).
   * @param {object} [opts]
   * @param {boolean} [opts.lock=false]
   * @yields {Record}
   */
  async *readAll(opts = {}) {
    this.#ensureOpen();
    while (true) {
      const record = await this.readNext(opts);
      if (record === null) break;
      yield record;
    }
  }

  /**
   * Write a record to the file.
   * @param {Record} record
   * @returns {Promise<number>}
   */
  async write(record) {
    this.#ensureOpen();
    const req = DDMReq.buildPut({
      data: record.getContents(),
      nullMap: this.#format.hasNullFields ? record.getNullFieldMap() : undefined,
    });
    await this.#connection.send(req);
    const reply = await this.#connection.receive();
    const parsed = DDMRep.parsePut(reply);
    if (!parsed.success) {
      throw new AS400Error(`Failed to write record: ${parsed.messageId}`);
    }
    return parsed.recordNumber;
  }

  /**
   * Update the currently positioned record.
   * @param {Record} record
   */
  async update(record) {
    this.#ensureOpen();
    const req = DDMReq.buildUpdate({
      data: record.getContents(),
      nullMap: this.#format.hasNullFields ? record.getNullFieldMap() : undefined,
    });
    await this.#connection.send(req);
    const reply = await this.#connection.receive();
    const parsed = DDMRep.parseUpdate(reply);
    if (!parsed.success) {
      throw new AS400Error(`Failed to update record: ${parsed.messageId}`);
    }
  }

  /**
   * Delete the currently positioned record.
   */
  async deleteRecord() {
    this.#ensureOpen();
    const req = DDMReq.buildDelete();
    await this.#connection.send(req);
    const reply = await this.#connection.receive();
    const parsed = DDMRep.parseDelete(reply);
    if (!parsed.success) {
      throw new AS400Error(`Failed to delete record: ${parsed.messageId}`);
    }
  }

  /**
   * Close the file.
   */
  async close() {
    if (!this.#isOpen) return;
    const req = DDMReq.buildClose();
    await this.#connection.send(req);
    await this.#connection.receive();
    this.#isOpen = false;
  }

  // ---- Internal ----

  async #readByKey(key, searchType, direction, opts = {}) {
    this.#ensureOpen();
    const req = DDMReq.buildGetByKey({
      key,
      searchType,
      direction,
      recordCount: 1,
      lockRecord: opts.lock ?? false,
    });
    await this.#connection.send(req);
    const reply = await this.#connection.receive();
    return this.#parseReadReply(reply);
  }

  #parseReadReply(reply) {
    const parsed = DDMRep.parseGet(reply);
    if (parsed.endOfFile || !parsed.success) return null;
    if (!parsed.data) return null;

    const record = Record.fromBuffer(this.#format, parsed.data, parsed.recordNumber);
    if (parsed.nullMap) {
      record.applyNullFieldMap(parsed.nullMap);
    }
    return record;
  }

  #ensureOpen() {
    if (!this.#isOpen) {
      throw new AS400Error('File is not open');
    }
  }

  static #parsePath(path) {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);

    if (parts.length === 2 && !parts[0].includes('.')) {
      return { library: parts[0], file: parts[1] };
    }

    let library = '*LIBL';
    let file = '';
    for (const part of parts) {
      const upper = part.toUpperCase();
      if (upper === 'QSYS.LIB') continue;
      if (upper.endsWith('.LIB')) {
        library = upper.slice(0, -4);
      } else if (upper.endsWith('.FILE')) {
        file = upper.slice(0, -5);
      } else if (!file) {
        file = upper;
      }
    }
    if (!file) file = parts[parts.length - 1];
    return { library, file };
  }
}
