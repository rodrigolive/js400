/**
 * LOB locator protocol helpers.
 *
 * Handles LOB (Large Object) locator-based streaming for BLOB, CLOB,
 * and DBCLOB types. LOB locators are server-side handles that allow
 * incremental reading/writing of large data without fetching everything
 * in a single row.
 *
 * Upstream: DBLobData.java, JDSkippedLocator.java
 * @module db/protocol/DBLobData
 */

import { DBRequestDS } from './DBRequestDS.js';
import { parseOperationReply, getCodePointData, throwIfError } from './DBReplyDS.js';

/** Maximum chunk size for LOB retrieval (1 MB). */
const DEFAULT_LOB_CHUNK_SIZE = 1024 * 1024;

/**
 * Parse LOB locator data from a code point buffer.
 *
 * LOB locator layout in result data:
 *   0-3: Locator handle (int32)
 *   4-7: LOB length (int32, total byte length of the LOB)
 *
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @returns {LobLocator}
 */
export function parseLobLocator(buf, offset = 0) {
  if (buf.length < offset + 4) {
    return { handle: 0, length: 0 };
  }
  const handle = buf.readInt32BE(offset);
  const length = buf.length >= offset + 8 ? buf.readInt32BE(offset + 4) : 0;
  return { handle, length };
}

/**
 * Parse LOB data from a retrieve-LOB-data reply.
 * The actual LOB bytes come in a result data code point (0x3814).
 *
 * @param {Buffer} replyBuf - raw reply from retrieve LOB data request
 * @param {object} [opts]
 * @param {number} [opts.serverCCSID=37]
 * @returns {LobDataReply}
 */
export function parseLobDataReply(replyBuf, opts = {}) {
  const opReply = parseOperationReply(replyBuf, opts);
  const dataBuf = getCodePointData(opReply, 0x3814);

  return {
    sqlca: opReply.sqlca,
    data: dataBuf || Buffer.alloc(0),
    endOfData: opReply.sqlca.sqlCode === 100 || !dataBuf || dataBuf.length === 0,
  };
}

/**
 * Read an entire LOB through incremental locator reads.
 *
 * @param {object} connection - connection with sendAndReceive()
 * @param {number} rpbId - RPB ID for the statement context
 * @param {number} locatorHandle - server-side locator handle
 * @param {number} totalLength - total LOB byte length
 * @param {object} [opts]
 * @param {number} [opts.chunkSize] - bytes per read request
 * @param {number} [opts.serverCCSID=37]
 * @returns {Promise<Buffer>}
 */
export async function readEntireLob(connection, rpbId, locatorHandle, totalLength, opts = {}) {
  const chunkSize = opts.chunkSize ?? DEFAULT_LOB_CHUNK_SIZE;
  const serverCCSID = opts.serverCCSID ?? 37;
  const chunks = [];
  let bytesRead = 0;

  while (bytesRead < totalLength) {
    const readLen = Math.min(chunkSize, totalLength - bytesRead);
    const reqBuf = DBRequestDS.buildRetrieveLobData({
      rpbId,
      locatorHandle,
      offset: bytesRead,
      length: readLen,
    });

    const replyBuf = await connection.sendAndReceive(reqBuf);
    const lobReply = parseLobDataReply(replyBuf, { serverCCSID });

    if (lobReply.data.length > 0) {
      chunks.push(lobReply.data);
      bytesRead += lobReply.data.length;
    }

    if (lobReply.endOfData) break;
  }

  return Buffer.concat(chunks);
}

/**
 * Free a LOB locator on the server.
 *
 * @param {object} connection - connection with sendAndReceive()
 * @param {number} rpbId
 * @param {number} locatorHandle
 * @returns {Promise<void>}
 */
export async function freeLobLocator(connection, rpbId, locatorHandle) {
  const reqBuf = DBRequestDS.buildFreeLob({ rpbId, locatorHandle });
  const replyBuf = await connection.sendAndReceive(reqBuf);
  const opReply = parseOperationReply(replyBuf);
  throwIfError(opReply.sqlca, 'Free LOB locator');
}

/**
 * Represents a LOB value backed by a server-side locator.
 * Provides lazy streaming access to the LOB content.
 */
export class LobHandle {
  #connection;
  #rpbId;
  #handle;
  #length;
  #serverCCSID;
  #freed = false;

  constructor(connection, rpbId, handle, length, serverCCSID = 37) {
    this.#connection = connection;
    this.#rpbId = rpbId;
    this.#handle = handle;
    this.#length = length;
    this.#serverCCSID = serverCCSID;
  }

  get handle() { return this.#handle; }
  get length() { return this.#length; }
  get isFreed() { return this.#freed; }

  /**
   * Read a portion of the LOB.
   * @param {number} [offset=0]
   * @param {number} [length] - defaults to remaining bytes
   * @returns {Promise<Buffer>}
   */
  async read(offset = 0, length) {
    if (this.#freed) throw new Error('LOB locator already freed');
    const readLen = length ?? (this.#length - offset);
    const reqBuf = DBRequestDS.buildRetrieveLobData({
      rpbId: this.#rpbId,
      locatorHandle: this.#handle,
      offset,
      length: readLen,
    });
    const replyBuf = await this.#connection.sendAndReceive(reqBuf);
    const lobReply = parseLobDataReply(replyBuf, { serverCCSID: this.#serverCCSID });
    throwIfError(lobReply.sqlca, 'Read LOB data');
    return lobReply.data;
  }

  /**
   * Read the entire LOB content.
   * @param {object} [opts]
   * @param {number} [opts.chunkSize]
   * @returns {Promise<Buffer>}
   */
  async readAll(opts = {}) {
    if (this.#freed) throw new Error('LOB locator already freed');
    return readEntireLob(
      this.#connection, this.#rpbId, this.#handle, this.#length,
      { ...opts, serverCCSID: this.#serverCCSID },
    );
  }

  /**
   * Free the server-side locator.
   * @returns {Promise<void>}
   */
  async free() {
    if (this.#freed) return;
    await freeLobLocator(this.#connection, this.#rpbId, this.#handle);
    this.#freed = true;
  }
}

export class DBLobData {
  static parseLobLocator = parseLobLocator;
  static parseLobDataReply = parseLobDataReply;
  static readEntireLob = readEntireLob;
  static freeLobLocator = freeLobLocator;
  static LobHandle = LobHandle;
  static DEFAULT_LOB_CHUNK_SIZE = DEFAULT_LOB_CHUNK_SIZE;
}
