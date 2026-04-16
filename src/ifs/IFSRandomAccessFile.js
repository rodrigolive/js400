/**
 * Random-access IFS file support.
 *
 * Opens a file for both reading and writing with seek capability.
 * Provides read/write at arbitrary positions.
 *
 * Upstream: IFSRandomAccessFile.java, IFSRandomAccessFileImplRemote.java
 * @module ifs/IFSRandomAccessFile
 */

import { Service, ServiceToServerID } from '../core/constants.js';
import { AS400Error } from '../core/errors.js';
import { SeedExchange } from '../transport/SeedExchange.js';
import { ServerStart } from '../transport/ServerStart.js';
import { IFSReq, ACCESS_READ, ACCESS_WRITE, SHARE_DENY_NONE,
  OPEN_CREATE_OPEN, OPEN_FAIL_OPEN, CONVERT_NONE } from './protocol/IFSReq.js';
import { IFSRep, RC_SUCCESS, RC_NO_MORE_DATA } from './protocol/IFSRep.js';

const FILE_SERVER_ID = ServiceToServerID[Service.FILE];

async function ensureConnection(system) {
  const conn = await system.connectService(Service.FILE);
  if (!system.getServerAttributes(Service.FILE)) {
    const seedReq = SeedExchange.buildRequest(FILE_SERVER_ID);
    const seedReplyBuf = await conn.sendAndReceive(seedReq.buffer);
    const seedReply = SeedExchange.parseReply(seedReplyBuf);
    const startReq = ServerStart.buildRequest({
      serverId: FILE_SERVER_ID,
      user: system.user,
      password: system.password,
      clientSeed: seedReq.clientSeed,
      serverSeed: seedReply.serverSeed,
      passwordLevel: system.getPasswordLevel(),
    });
    const startReplyBuf = await conn.sendAndReceive(startReq);
    ServerStart.parseReply(startReplyBuf);
    system.setServerAttributes(Service.FILE, { connected: true });
  }
  return conn;
}

export class IFSRandomAccessFile {
  #system;
  #path;
  #fileHandle = 0;
  #position = 0;
  #opened = false;
  #closed = false;
  #fileSize = 0;
  #mode;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - Full IFS path
   * @param {string} [mode='rw'] - 'r' = read only, 'rw' = read/write
   */
  constructor(system, path, mode = 'rw') {
    this.#system = system;
    this.#path = path;
    this.#mode = mode;
  }

  get path() { return this.#path; }
  get position() { return this.#position; }
  get fileSize() { return this.#fileSize; }

  /**
   * Open the file.
   * @returns {Promise<void>}
   */
  async open() {
    if (this.#opened) return;
    if (this.#closed) throw new Error('File already closed');

    const accessIntent = this.#mode === 'r' ? ACCESS_READ : (ACCESS_READ | ACCESS_WRITE);
    const openOption = this.#mode === 'r' ? OPEN_FAIL_OPEN : OPEN_CREATE_OPEN;

    const conn = await ensureConnection(this.#system);
    const reqBuf = IFSReq.buildOpen({
      fileName: this.#path,
      accessIntent,
      shareMode: SHARE_DENY_NONE,
      openOption,
      dataConversion: CONVERT_NONE,
    });

    const replyBuf = await conn.sendAndReceive(reqBuf);
    const result = IFSRep.parseOpen(replyBuf);

    if (result.returnCode !== RC_SUCCESS) {
      throw new AS400Error(
        `IFS open failed: ${IFSRep.returnCodeMessage(result.returnCode)} path='${this.#path}'`,
        { returnCode: result.returnCode, hostService: 'FILE' }
      );
    }

    this.#fileHandle = result.fileHandle;
    this.#fileSize = result.fileSize;
    this.#opened = true;
  }

  /**
   * Read up to `length` bytes at the current position.
   * @param {number} [length=65536]
   * @returns {Promise<Buffer>}
   */
  async read(length = 65536) {
    if (!this.#opened) await this.open();

    const conn = await ensureConnection(this.#system);
    const reqBuf = IFSReq.buildRead({
      fileHandle: this.#fileHandle,
      offset: this.#position,
      length,
    });

    const replyBuf = await conn.sendAndReceive(reqBuf);
    const result = IFSRep.parseRead(replyBuf);

    if (result.returnCode === RC_NO_MORE_DATA || result.data.length === 0) {
      return Buffer.alloc(0);
    }

    if (result.returnCode !== RC_SUCCESS) {
      throw new AS400Error(
        `IFS read failed: ${IFSRep.returnCodeMessage(result.returnCode)}`,
        { returnCode: result.returnCode, hostService: 'FILE' }
      );
    }

    this.#position += result.data.length;
    return result.data;
  }

  /**
   * Write data at the current position.
   * @param {Buffer} data
   * @returns {Promise<void>}
   */
  async write(data) {
    if (!this.#opened) await this.open();

    const conn = await ensureConnection(this.#system);
    const reqBuf = IFSReq.buildWrite({
      fileHandle: this.#fileHandle,
      offset: this.#position,
      data,
    });

    const replyBuf = await conn.sendAndReceive(reqBuf);
    const result = IFSRep.parseWrite(replyBuf);

    if (result.returnCode !== RC_SUCCESS) {
      throw new AS400Error(
        `IFS write failed: ${IFSRep.returnCodeMessage(result.returnCode)}`,
        { returnCode: result.returnCode, hostService: 'FILE' }
      );
    }

    this.#position += data.length - (result.bytesNotWritten || 0);
    if (this.#position > this.#fileSize) {
      this.#fileSize = this.#position;
    }
  }

  /**
   * Seek to an absolute position.
   * @param {number} pos
   */
  seek(pos) {
    this.#position = pos;
  }

  /**
   * Get the current file pointer position.
   * @returns {number}
   */
  getFilePointer() {
    return this.#position;
  }

  /**
   * Close the file handle.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#closed || !this.#opened) {
      this.#closed = true;
      return;
    }

    try {
      const conn = await ensureConnection(this.#system);
      const reqBuf = IFSReq.buildClose({ fileHandle: this.#fileHandle });
      const replyBuf = await conn.sendAndReceive(reqBuf);
      IFSRep.parseReturnCode(replyBuf);
    } finally {
      this.#closed = true;
      this.#opened = false;
      this.#fileHandle = 0;
    }
  }
}
