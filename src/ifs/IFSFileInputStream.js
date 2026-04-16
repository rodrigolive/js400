/**
 * Binary read stream for IFS files.
 *
 * Opens a file for reading, provides read() and readAll() methods,
 * and handles file handle lifecycle.
 *
 * Upstream: IFSFileInputStream.java, IFSFileInputStreamImplRemote.java
 * @module ifs/IFSFileInputStream
 */

import { Service, ServiceToServerID } from '../core/constants.js';
import { AS400Error } from '../core/errors.js';
import { SeedExchange } from '../transport/SeedExchange.js';
import { ServerStart } from '../transport/ServerStart.js';
import { IFSReq, ACCESS_READ, SHARE_DENY_NONE, OPEN_FAIL_OPEN,
  CONVERT_NONE } from './protocol/IFSReq.js';
import { IFSRep, RC_SUCCESS, RC_NO_MORE_DATA } from './protocol/IFSRep.js';

const FILE_SERVER_ID = ServiceToServerID[Service.FILE];
const DEFAULT_READ_SIZE = 65536;

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

export class IFSFileInputStream {
  #system;
  #path;
  #fileHandle = 0;
  #position = 0;
  #opened = false;
  #closed = false;
  #fileSize = 0;
  #shareMode;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - Full IFS path
   * @param {object} [opts]
   * @param {number} [opts.shareMode=SHARE_DENY_NONE]
   */
  constructor(system, path, opts = {}) {
    this.#system = system;
    this.#path = path;
    this.#shareMode = opts.shareMode ?? SHARE_DENY_NONE;
  }

  get path() { return this.#path; }
  get position() { return this.#position; }
  get fileSize() { return this.#fileSize; }

  /**
   * Open the file for reading.
   * Called automatically on first read if not already open.
   * @returns {Promise<void>}
   */
  async open() {
    if (this.#opened) return;
    if (this.#closed) throw new Error('Stream already closed');

    const conn = await ensureConnection(this.#system);
    const reqBuf = IFSReq.buildOpen({
      fileName: this.#path,
      accessIntent: ACCESS_READ,
      shareMode: this.#shareMode,
      openOption: OPEN_FAIL_OPEN,
      dataConversion: CONVERT_NONE,
    });

    const replyBuf = await conn.sendAndReceive(reqBuf);
    const result = IFSRep.parseOpen(replyBuf);

    if (result.returnCode !== RC_SUCCESS) {
      throw new AS400Error(
        `IFS open for read failed: ${IFSRep.returnCodeMessage(result.returnCode)} path='${this.#path}'`,
        { returnCode: result.returnCode, hostService: 'FILE' }
      );
    }

    this.#fileHandle = result.fileHandle;
    this.#fileSize = result.fileSize;
    this.#opened = true;
  }

  /**
   * Read up to `length` bytes from the file starting at the current position.
   *
   * @param {number} [length=65536] - Number of bytes to read
   * @returns {Promise<Buffer>} Data read (may be shorter than requested at EOF)
   */
  async read(length = DEFAULT_READ_SIZE) {
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
   * Read the entire file contents.
   *
   * @param {number} [chunkSize=65536] - Size of each read request
   * @returns {Promise<Buffer>}
   */
  async readAll(chunkSize = DEFAULT_READ_SIZE) {
    if (!this.#opened) await this.open();

    const chunks = [];
    while (true) {
      const chunk = await this.read(chunkSize);
      if (chunk.length === 0) break;
      chunks.push(chunk);
    }

    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  }

  /**
   * Skip forward by `n` bytes.
   * @param {number} n
   */
  skip(n) {
    this.#position += n;
  }

  /**
   * Seek to an absolute position.
   * @param {number} pos
   */
  seek(pos) {
    this.#position = pos;
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
