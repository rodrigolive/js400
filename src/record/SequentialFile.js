/**
 * Sequential record access.
 *
 * Provides sequential read, write, update, and delete operations on
 * a physical file. Records are accessed in arrival sequence (RRN order).
 *
 * Upstream: SequentialFile.java, AS400File.java, AS400FileImplRemote.java
 * @module record/SequentialFile
 */

import { AS400Error } from '../core/errors.js';
import { Record } from './Record.js';
import { DDMReq } from './protocol/DDMReq.js';
import { DDMRep } from './protocol/DDMRep.js';
import { DDMPool } from './protocol/DDMPool.js';
import { FileRecordDescription } from './description/FileRecordDescription.js';

/** Read direction constants. */
export const DIRECTION = Object.freeze({
  NEXT:     1,
  PREVIOUS: 2,
  FIRST:    3,
  LAST:     4,
});

export class SequentialFile {
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
  /** @type {number} Commit lock level */
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
    const { library, file } = SequentialFile.#parsePath(this.#path);
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
   * @param {number} [blockingFactor=1] - Number of records per block
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

    const { library, file } = SequentialFile.#parsePath(this.#path);
    const req = DDMReq.buildOpen({
      fileName: `${library}/${file}`,
      member: this.#member,
      openType,
      blockingFactor,
      recordFormatName: this.#format.name,
      keyed: false,
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
   * Read the next record.
   * @param {object} [opts]
   * @param {boolean} [opts.lock=false]
   * @returns {Promise<Record|null>}
   */
  async readNext(opts = {}) {
    return this.#readDirection(DIRECTION.NEXT, opts);
  }

  /**
   * Read the previous record.
   * @param {object} [opts]
   * @param {boolean} [opts.lock=false]
   * @returns {Promise<Record|null>}
   */
  async readPrevious(opts = {}) {
    return this.#readDirection(DIRECTION.PREVIOUS, opts);
  }

  /**
   * Read the first record.
   * @param {object} [opts]
   * @param {boolean} [opts.lock=false]
   * @returns {Promise<Record|null>}
   */
  async readFirst(opts = {}) {
    return this.#readDirection(DIRECTION.FIRST, opts);
  }

  /**
   * Read the last record.
   * @param {object} [opts]
   * @param {boolean} [opts.lock=false]
   * @returns {Promise<Record|null>}
   */
  async readLast(opts = {}) {
    return this.#readDirection(DIRECTION.LAST, opts);
  }

  /**
   * Position the cursor to the first record.
   */
  async positionCursorToFirst() {
    this.#ensureOpen();
    const req = DDMReq.buildGet({ direction: DIRECTION.FIRST, recordCount: 0 });
    await this.#connection.send(req);
    await this.#connection.receive();
  }

  /**
   * Position the cursor to the last record.
   */
  async positionCursorToLast() {
    this.#ensureOpen();
    const req = DDMReq.buildGet({ direction: DIRECTION.LAST, recordCount: 0 });
    await this.#connection.send(req);
    await this.#connection.receive();
  }

  /**
   * Read all records as an async iterable.
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
   * @returns {Promise<number>} Record number of the written record
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

  async #readDirection(direction, opts = {}) {
    this.#ensureOpen();
    const req = DDMReq.buildGet({
      direction,
      recordCount: 1,
      lockRecord: opts.lock ?? false,
    });
    await this.#connection.send(req);
    const reply = await this.#connection.receive();
    const parsed = DDMRep.parseGet(reply);

    if (parsed.endOfFile || !parsed.success) {
      return null;
    }

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

  /**
   * Parse an IFS QSYS path into library and file components.
   * @param {string} path
   * @returns {{ library: string, file: string }}
   */
  static #parsePath(path) {
    // /QSYS.LIB/MYLIB.LIB/CUSTMAS.FILE  or  MYLIB/CUSTMAS
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);

    // Simple format: MYLIB/FILE
    if (parts.length === 2 && !parts[0].includes('.')) {
      return { library: parts[0], file: parts[1] };
    }

    // IFS format: QSYS.LIB/MYLIB.LIB/CUSTMAS.FILE
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
