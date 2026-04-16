/**
 * Binary write stream for IFS files.
 *
 * Opens a file for writing, provides write() and close() methods,
 * and handles file handle lifecycle.
 *
 * Upstream: IFSFileOutputStream.java, IFSFileOutputStreamImplRemote.java
 * @module ifs/IFSFileOutputStream
 */

import { Service, ServiceToServerID } from '../core/constants.js';
import { AS400Error } from '../core/errors.js';
import { SeedExchange } from '../transport/SeedExchange.js';
import { ServerStart } from '../transport/ServerStart.js';
import { IFSReq, ACCESS_WRITE, SHARE_DENY_NONE, OPEN_CREATE_OPEN,
  OPEN_CREATE_REPLACE, CONVERT_NONE } from './protocol/IFSReq.js';
import { IFSRep, RC_SUCCESS } from './protocol/IFSRep.js';

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

export class IFSFileOutputStream {
  #system;
  #path;
  #fileHandle = 0;
  #position = 0;
  #opened = false;
  #closed = false;
  #shareMode;
  #append;
  #ccsid;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - Full IFS path
   * @param {object} [opts]
   * @param {number} [opts.shareMode=SHARE_DENY_NONE]
   * @param {boolean} [opts.append=false] - Append mode (seek to end on open)
   * @param {number} [opts.ccsid=0xFFFF] - File data CCSID (binary by default)
   */
  constructor(system, path, opts = {}) {
    this.#system = system;
    this.#path = path;
    this.#shareMode = opts.shareMode ?? SHARE_DENY_NONE;
    this.#append = opts.append ?? false;
    this.#ccsid = opts.ccsid ?? 0xFFFF;
  }

  get path() { return this.#path; }
  get position() { return this.#position; }

  /**
   * Open the file for writing.
   * Creates the file if it doesn't exist. In non-append mode, replaces existing content.
   * @returns {Promise<void>}
   */
  async open() {
    if (this.#opened) return;
    if (this.#closed) throw new Error('Stream already closed');

    const conn = await ensureConnection(this.#system);
    const reqBuf = IFSReq.buildOpen({
      fileName: this.#path,
      accessIntent: ACCESS_WRITE,
      shareMode: this.#shareMode,
      openOption: this.#append ? OPEN_CREATE_OPEN : OPEN_CREATE_REPLACE,
      dataConversion: CONVERT_NONE,
      fileDataCCSID: this.#ccsid,
    });

    const replyBuf = await conn.sendAndReceive(reqBuf);
    const result = IFSRep.parseOpen(replyBuf);

    if (result.returnCode !== RC_SUCCESS) {
      throw new AS400Error(
        `IFS open for write failed: ${IFSRep.returnCodeMessage(result.returnCode)} path='${this.#path}'`,
        { returnCode: result.returnCode, hostService: 'FILE' }
      );
    }

    this.#fileHandle = result.fileHandle;
    this.#opened = true;

    if (this.#append) {
      this.#position = result.fileSize;
    }
  }

  /**
   * Write data to the file at the current position.
   *
   * @param {Buffer} data - Data to write
   * @returns {Promise<void>}
   */
  async write(data) {
    if (!this.#opened) await this.open();

    const conn = await ensureConnection(this.#system);
    const reqBuf = IFSReq.buildWrite({
      fileHandle: this.#fileHandle,
      offset: this.#position,
      data,
      ccsid: this.#ccsid,
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
  }

  /**
   * Flush and close the file handle.
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
