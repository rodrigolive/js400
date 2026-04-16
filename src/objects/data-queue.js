/**
 * Data queue and keyed data queue access.
 *
 * Uses the data queue host server (service 3, port 8472) with native
 * datastream protocol for write/read/peek/clear/create/delete/getAttributes.
 *
 * Upstream: DataQueue.java, KeyedDataQueue.java, DataQueueEntry.java,
 *           KeyedDataQueueEntry.java, DataQueueAttributes.java,
 *           BaseDataQueueImplRemote.java, DQ*DataStream.java
 * @module objects/data-queue
 */

import { Service, ServerID } from '../core/constants.js';
import { Trace } from '../core/Trace.js';
import { AS400Error, DatastreamError } from '../core/errors.js';
import { SeedExchange } from '../transport/SeedExchange.js';
import { ServerStart } from '../transport/ServerStart.js';
import { encryptPassword, stringToEbcdic } from '../auth/password-encrypt.js';
import { CharConverter } from '../ccsid/CharConverter.js';
import { QSYSObjectPathName } from '../ifs/QSYSObjectPathName.js';

const DQ_SERVER_ID = ServerID.DATAQUEUE; // 0xE007
const DQ_STATE = Symbol.for('js400.dqState');

// Request IDs
const REQ_EXCHANGE_ATTRS = 0x0000;
const REQ_GET_ATTRS = 0x0001;
const REQ_READ = 0x0002;
const REQ_CREATE = 0x0003;
const REQ_DELETE = 0x0004;
const REQ_WRITE = 0x0005;
const REQ_CLEAR = 0x0006;

// Reply IDs (hashCode)
const REP_EXCHANGE_ATTRS = 0x8000;
const REP_GET_ATTRS = 0x8001;
const REP_COMMON = 0x8002;
const REP_READ_NORMAL = 0x8003;

// Return codes
const RC_SUCCESS = 0xF000;
const RC_NO_DATA = 0xF006;

// Code points for optional params
const CP_ENTRY = 0x5001;
const CP_KEY = 0x5002;

// Queue type flags
const QT_NON_KEYED = 0xF0;
const QT_KEYED = 0xF1;

// Peek flags
const PEEK_NO = 0xF0;
const PEEK_YES = 0xF1;

// Authority flags
const AUTH_MAP = {
  '*ALL': 0xF0,
  '*CHANGE': 0xF1,
  '*EXCLUDE': 0xF2,
  '*USE': 0xF3,
  '*LIBCRTAUT': 0xF4,
};

// Queue order types
const ORDER_FIFO = 0xF0;
const ORDER_LIFO = 0xF1;
const ORDER_KEYED = 0xF2;

/**
 * Ensure the data queue server connection is established.
 * @param {import('../core/AS400.js').AS400} system
 * @returns {Promise<{connection: import('../transport/Connection.js').Connection, ccsid: number}>}
 */
async function ensureDQConnection(system) {
  const existing = system[DQ_STATE];
  if (existing && existing.connection && existing.connection.connected) {
    return existing;
  }

  const conn = await system.connectService(Service.DATAQUEUE);

  // Seed exchange
  const { buffer: seedReq, clientSeed } = SeedExchange.buildRequest(DQ_SERVER_ID);
  const seedReplyBuf = await conn.sendAndReceive(seedReq);
  const seedReply = SeedExchange.parseReply(seedReplyBuf);

  // Server start (authenticate)
  const encPw = encryptPassword({
    userId: system.user,
    password: system.password,
    clientSeed,
    serverSeed: seedReply.serverSeed,
    passwordLevel: system.getPasswordLevel(),
  });

  const userIdEbcdic = stringToEbcdic(system.user, true);
  const startReq = ServerStart.buildRequest({
    serverId: DQ_SERVER_ID,
    authenticationBytes: Buffer.from(encPw),
    userIdBytes: Buffer.from(userIdEbcdic),
    authScheme: 0,
  });

  const startReplyBuf = await conn.sendAndReceive(startReq);
  ServerStart.parseReply(startReplyBuf);

  // Exchange attributes
  const exchBuf = buildExchangeAttrsReq();
  const exchReplyBuf = await conn.sendAndReceive(exchBuf);
  parseExchangeAttrsReply(exchReplyBuf);

  const ccsid = system.getServerCCSID() || 37;
  const state = { connection: conn, ccsid };
  system[DQ_STATE] = state;

  return state;
}

/**
 * Build exchange attributes request (26 bytes).
 */
function buildExchangeAttrsReq() {
  const buf = Buffer.alloc(26);
  buf.writeUInt32BE(26, 0);
  buf.writeUInt16BE(0, 4);
  buf.writeUInt16BE(DQ_SERVER_ID, 6);
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(0, 12);
  buf.writeUInt16BE(6, 16); // template = 26 - 20
  buf.writeUInt16BE(REQ_EXCHANGE_ATTRS, 18);
  buf.writeUInt32BE(1, 20); // client version (supports 64K)
  buf.writeUInt16BE(0, 24); // client DS level
  return buf;
}

/**
 * Parse exchange attributes reply.
 */
function parseExchangeAttrsReply(buf) {
  const repId = buf.readUInt16BE(18);
  if (repId !== REP_EXCHANGE_ATTRS && repId !== REP_COMMON) {
    // Check for error reply
    if (repId === REP_COMMON || (buf.length >= 22 && buf.readUInt16BE(20) !== RC_SUCCESS)) {
      throw new DatastreamError('DQ exchange attributes failed');
    }
  }
}

/**
 * Pad name to 10-byte EBCDIC with 0x40 blanks.
 */
function padName(name, ccsid) {
  const conv = new CharConverter(ccsid);
  const buf = Buffer.alloc(10, 0x40);
  const encoded = conv.stringToByteArray(name.toUpperCase());
  encoded.copy(buf, 0, 0, Math.min(encoded.length, 10));
  return buf;
}

/**
 * Parse the common reply (error/success).
 */
function parseCommonReply(buf) {
  const rc = buf.readUInt16BE(20);
  let message = null;
  if (buf.length > 22) {
    const ll = buf.readUInt32BE(22);
    if (ll > 6 && buf.length >= 28 + (ll - 6)) {
      message = buf.subarray(28, 22 + ll);
    }
  }
  return { rc, message };
}

/**
 * Parse a read-normal reply (hashCode 0x8003).
 */
function parseReadReply(buf) {
  if (buf.length < 58) {
    return { entry: null, key: null, senderInfo: null };
  }

  // Sender info: 36 bytes at offset 22
  const senderInfo = buf.subarray(22, 58);

  // Optional parameters start at offset 58
  let entry = null;
  let key = null;
  let offset = 58;

  while (offset < buf.length - 6) {
    const ll = buf.readUInt32BE(offset);
    if (ll < 6 || offset + ll > buf.length) break;
    const cp = buf.readUInt16BE(offset + 4);
    const data = Buffer.alloc(ll - 6);
    buf.copy(data, 0, offset + 6, offset + ll);

    if (cp === CP_ENTRY) entry = data;
    else if (cp === CP_KEY) key = data;

    offset += ll;
  }

  return { entry, key, senderInfo };
}

/**
 * Represents a data queue entry returned from read/peek.
 */
export class DataQueueEntry {
  #data;
  #senderInfo;

  constructor(data, senderInfo) {
    this.#data = data;
    this.#senderInfo = senderInfo;
  }

  getData() { return this.#data; }
  getSenderInformation() { return this.#senderInfo; }
}

/**
 * Represents a keyed data queue entry returned from read/peek.
 */
export class KeyedDataQueueEntry extends DataQueueEntry {
  #key;

  constructor(data, key, senderInfo) {
    super(data, senderInfo);
    this.#key = key;
  }

  getKey() { return this.#key; }
}

/**
 * Represents data queue attributes.
 */
export class DataQueueAttributes {
  constructor(opts) {
    this.maxEntryLength = opts.maxEntryLength;
    this.saveSenderInfo = opts.saveSenderInfo;
    this.queueType = opts.queueType;
    this.keyLength = opts.keyLength;
    this.forceToAuxStorage = opts.forceToAuxStorage;
    this.description = opts.description;
  }
}

/**
 * Data queue — write/read/peek/clear/create/delete operations.
 */
export class DataQueue {
  #system;
  #path;
  #library;
  #name;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - IFS path like /QSYS.LIB/MYLIB.LIB/MYQ.DTAQ
   */
  constructor(system, path) {
    if (!system) throw new Error('DataQueue requires an AS400 instance');
    if (!path) throw new Error('DataQueue requires a path');
    this.#system = system;
    this.#path = path;
    const parsed = QSYSObjectPathName.parse(path);
    this.#library = parsed.library;
    this.#name = parsed.object;
  }

  get path() { return this.#path; }
  get library() { return this.#library; }
  get name() { return this.#name; }

  /**
   * Write data to the queue.
   * @param {Buffer|Uint8Array} data
   * @returns {Promise<void>}
   */
  async write(data) {
    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);
    const entryData = Buffer.isBuffer(data) ? data : Buffer.from(data);

    // 20 header + 22 template + (6 + entryLen) entry
    const totalLen = 48 + entryData.length;
    const buf = Buffer.alloc(totalLen);

    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(22, 16); // template length
    buf.writeUInt16BE(REQ_WRITE, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);
    buf[40] = QT_NON_KEYED;
    buf[41] = 0xF1; // want reply

    // Entry LL/CP
    buf.writeUInt32BE(6 + entryData.length, 42);
    buf.writeUInt16BE(CP_ENTRY, 46);
    entryData.copy(buf, 48);

    const reply = await connection.sendAndReceive(buf);
    const { rc, message } = parseCommonReply(reply);
    if (rc !== RC_SUCCESS) {
      throw new AS400Error(`Data queue write failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }
  }

  /**
   * Read and remove an entry from the queue.
   * @param {number} [wait=0] - Seconds to wait (-1 = forever, 0 = no wait)
   * @returns {Promise<DataQueueEntry|null>}
   */
  async read(wait = 0) {
    return this.#readInternal(wait, false);
  }

  /**
   * Peek at an entry without removing it.
   * @param {number} [wait=0] - Seconds to wait
   * @returns {Promise<DataQueueEntry|null>}
   */
  async peek(wait = 0) {
    return this.#readInternal(wait, true);
  }

  /**
   * Clear all entries from the queue.
   * @returns {Promise<void>}
   */
  async clear() {
    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);

    const buf = Buffer.alloc(41);
    buf.writeUInt32BE(41, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(21, 16);
    buf.writeUInt16BE(REQ_CLEAR, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);
    buf[40] = QT_NON_KEYED;

    const reply = await connection.sendAndReceive(buf);
    const { rc } = parseCommonReply(reply);
    if (rc !== RC_SUCCESS) {
      throw new AS400Error(`Data queue clear failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }
  }

  /**
   * Create the data queue on the system.
   * @param {object} [opts]
   * @param {number} [opts.maxEntryLength=1000]
   * @param {string} [opts.authority='*LIBCRTAUT']
   * @param {boolean} [opts.saveSenderInfo=false]
   * @param {string} [opts.order='FIFO'] - 'FIFO' or 'LIFO'
   * @param {boolean} [opts.forceToAuxStorage=false]
   * @param {string} [opts.description='']
   * @returns {Promise<void>}
   */
  async create(opts = {}) {
    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);

    const maxLen = opts.maxEntryLength ?? 1000;
    const auth = AUTH_MAP[opts.authority ?? '*LIBCRTAUT'] ?? AUTH_MAP['*LIBCRTAUT'];
    const saveSender = opts.saveSenderInfo ? 0xF1 : 0xF0;
    const order = (opts.order ?? 'FIFO').toUpperCase() === 'LIFO' ? ORDER_LIFO : ORDER_FIFO;
    const force = opts.forceToAuxStorage ? 0xF1 : 0xF0;

    const descStr = (opts.description ?? '').padEnd(50, ' ').substring(0, 50);
    const conv = new CharConverter(ccsid);
    const descBytes = conv.stringToByteArray(descStr);

    const buf = Buffer.alloc(100);
    buf.writeUInt32BE(100, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(80, 16); // template = 100 - 20
    buf.writeUInt16BE(REQ_CREATE, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);
    buf.writeUInt32BE(maxLen, 40);
    buf[44] = auth;
    buf[45] = saveSender;
    buf[46] = order;
    buf.writeUInt16BE(0, 47); // key length = 0 for non-keyed
    buf[49] = force;
    descBytes.copy(buf, 50, 0, Math.min(descBytes.length, 50));

    const reply = await connection.sendAndReceive(buf);
    const { rc } = parseCommonReply(reply);
    if (rc !== RC_SUCCESS) {
      throw new AS400Error(`Data queue create failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }
  }

  /**
   * Delete the data queue from the system.
   * @returns {Promise<void>}
   */
  async delete() {
    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);

    const buf = Buffer.alloc(40);
    buf.writeUInt32BE(40, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(20, 16);
    buf.writeUInt16BE(REQ_DELETE, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);

    const reply = await connection.sendAndReceive(buf);
    const { rc } = parseCommonReply(reply);
    if (rc !== RC_SUCCESS) {
      throw new AS400Error(`Data queue delete failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }
  }

  /**
   * Get queue attributes.
   * @returns {Promise<DataQueueAttributes>}
   */
  async getAttributes() {
    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);

    const buf = Buffer.alloc(40);
    buf.writeUInt32BE(40, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(20, 16);
    buf.writeUInt16BE(REQ_GET_ATTRS, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);

    const reply = await connection.sendAndReceive(buf);
    const repId = reply.readUInt16BE(18);

    if (repId === REP_COMMON) {
      const { rc } = parseCommonReply(reply);
      throw new AS400Error(`Data queue getAttributes failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }

    // Parse attributes reply (repId === 0x8001)
    const conv = new CharConverter(ccsid);
    const maxEntryLength = reply.readUInt32BE(22);
    const saveSenderInfo = reply[26] === 0xF1;
    const queueTypeByte = reply[27];
    let queueType = 'FIFO';
    if (queueTypeByte === ORDER_LIFO) queueType = 'LIFO';
    else if (queueTypeByte === ORDER_KEYED) queueType = 'KEYED';
    const keyLength = reply.readUInt16BE(28);
    const forceToAuxStorage = reply[30] === 0xF1;
    const description = conv.byteArrayToString(reply, 31, 50).trim();

    return new DataQueueAttributes({
      maxEntryLength,
      saveSenderInfo,
      queueType,
      keyLength,
      forceToAuxStorage,
      description,
    });
  }

  /**
   * Internal read/peek implementation.
   */
  async #readInternal(wait, peek) {
    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);
    const searchBytes = Buffer.alloc(2, 0x40); // blank search (not keyed)

    const buf = Buffer.alloc(48);
    buf.writeUInt32BE(48, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(28, 16);
    buf.writeUInt16BE(REQ_READ, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);
    buf[40] = QT_NON_KEYED;
    searchBytes.copy(buf, 41);
    buf.writeInt32BE(wait < 0 ? -1 : wait, 43);
    buf[47] = peek ? PEEK_YES : PEEK_NO;

    const reply = await connection.sendAndReceive(buf);
    const repId = reply.readUInt16BE(18);

    if (repId === REP_COMMON) {
      const { rc } = parseCommonReply(reply);
      if (rc === RC_NO_DATA) return null;
      throw new AS400Error(`Data queue read failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }

    // Normal read reply
    const { entry, senderInfo } = parseReadReply(reply);
    if (!entry) return null;

    return new DataQueueEntry(entry, senderInfo);
  }
}

/**
 * Keyed data queue — extends DataQueue with key-based operations.
 */
export class KeyedDataQueue {
  #system;
  #path;
  #library;
  #name;
  #keyLength;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - IFS path like /QSYS.LIB/MYLIB.LIB/MYKEYQ.DTAQ
   */
  constructor(system, path) {
    if (!system) throw new Error('KeyedDataQueue requires an AS400 instance');
    if (!path) throw new Error('KeyedDataQueue requires a path');
    this.#system = system;
    this.#path = path;
    const parsed = QSYSObjectPathName.parse(path);
    this.#library = parsed.library;
    this.#name = parsed.object;
    this.#keyLength = 0;
  }

  get path() { return this.#path; }
  get library() { return this.#library; }
  get name() { return this.#name; }

  /**
   * Write data with a key.
   * @param {string|Buffer} key
   * @param {Buffer|Uint8Array} data
   * @returns {Promise<void>}
   */
  async write(key, data) {
    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);
    const entryData = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const keyData = this.#toKeyBuffer(key, ccsid);

    // 20 header + 22 template + (6 + entryLen) entry + (6 + keyLen) key
    const totalLen = 48 + entryData.length + 6 + keyData.length;
    const buf = Buffer.alloc(totalLen);

    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(22, 16);
    buf.writeUInt16BE(REQ_WRITE, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);
    buf[40] = QT_KEYED;
    buf[41] = 0xF1; // want reply

    // Entry LL/CP
    let offset = 42;
    buf.writeUInt32BE(6 + entryData.length, offset);
    buf.writeUInt16BE(CP_ENTRY, offset + 4);
    entryData.copy(buf, offset + 6);
    offset += 6 + entryData.length;

    // Key LL/CP
    buf.writeUInt32BE(6 + keyData.length, offset);
    buf.writeUInt16BE(CP_KEY, offset + 4);
    keyData.copy(buf, offset + 6);

    const reply = await connection.sendAndReceive(buf);
    const { rc } = parseCommonReply(reply);
    if (rc !== RC_SUCCESS) {
      throw new AS400Error(`Keyed data queue write failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }
  }

  /**
   * Read and remove an entry by key.
   * @param {string|Buffer} key
   * @param {number} [wait=0]
   * @param {string} [searchType='EQ'] - EQ, NE, LT, LE, GT, GE
   * @returns {Promise<KeyedDataQueueEntry|null>}
   */
  async read(key, wait = 0, searchType = 'EQ') {
    return this.#readInternal(key, wait, searchType, false);
  }

  /**
   * Peek at an entry by key without removing.
   * @param {string|Buffer} key
   * @param {number} [wait=0]
   * @param {string} [searchType='EQ']
   * @returns {Promise<KeyedDataQueueEntry|null>}
   */
  async peek(key, wait = 0, searchType = 'EQ') {
    return this.#readInternal(key, wait, searchType, true);
  }

  /**
   * Clear entries from the queue.
   * @param {string|Buffer} [key] - If provided, clear only matching entries
   * @returns {Promise<void>}
   */
  async clear(key) {
    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);

    let totalLen = 41;
    let keyData = null;
    if (key != null) {
      keyData = this.#toKeyBuffer(key, ccsid);
      totalLen += 6 + keyData.length;
    }

    const buf = Buffer.alloc(totalLen);
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(21, 16);
    buf.writeUInt16BE(REQ_CLEAR, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);
    buf[40] = QT_KEYED;

    if (keyData) {
      buf.writeUInt32BE(6 + keyData.length, 41);
      buf.writeUInt16BE(CP_KEY, 45);
      keyData.copy(buf, 47);
    }

    const reply = await connection.sendAndReceive(buf);
    const { rc } = parseCommonReply(reply);
    if (rc !== RC_SUCCESS) {
      throw new AS400Error(`Keyed data queue clear failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }
  }

  /**
   * Create the keyed data queue.
   * @param {object} opts
   * @param {number} opts.keyLength - Key length in bytes
   * @param {number} [opts.maxEntryLength=1000]
   * @param {string} [opts.authority='*LIBCRTAUT']
   * @param {boolean} [opts.saveSenderInfo=false]
   * @param {boolean} [opts.forceToAuxStorage=false]
   * @param {string} [opts.description='']
   * @returns {Promise<void>}
   */
  async create(opts = {}) {
    if (!opts.keyLength) throw new Error('keyLength is required for keyed data queue');
    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);

    const maxLen = opts.maxEntryLength ?? 1000;
    const auth = AUTH_MAP[opts.authority ?? '*LIBCRTAUT'] ?? AUTH_MAP['*LIBCRTAUT'];
    const saveSender = opts.saveSenderInfo ? 0xF1 : 0xF0;
    const force = opts.forceToAuxStorage ? 0xF1 : 0xF0;

    const descStr = (opts.description ?? '').padEnd(50, ' ').substring(0, 50);
    const conv = new CharConverter(ccsid);
    const descBytes = conv.stringToByteArray(descStr);

    const buf = Buffer.alloc(100);
    buf.writeUInt32BE(100, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(80, 16);
    buf.writeUInt16BE(REQ_CREATE, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);
    buf.writeUInt32BE(maxLen, 40);
    buf[44] = auth;
    buf[45] = saveSender;
    buf[46] = ORDER_KEYED;
    buf.writeUInt16BE(opts.keyLength, 47);
    buf[49] = force;
    descBytes.copy(buf, 50, 0, Math.min(descBytes.length, 50));

    this.#keyLength = opts.keyLength;

    const reply = await connection.sendAndReceive(buf);
    const { rc } = parseCommonReply(reply);
    if (rc !== RC_SUCCESS) {
      throw new AS400Error(`Keyed data queue create failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }
  }

  /**
   * Delete the keyed data queue.
   * @returns {Promise<void>}
   */
  async delete() {
    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);

    const buf = Buffer.alloc(40);
    buf.writeUInt32BE(40, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(20, 16);
    buf.writeUInt16BE(REQ_DELETE, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);

    const reply = await connection.sendAndReceive(buf);
    const { rc } = parseCommonReply(reply);
    if (rc !== RC_SUCCESS) {
      throw new AS400Error(`Keyed data queue delete failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }
  }

  /**
   * Get queue attributes.
   * @returns {Promise<DataQueueAttributes>}
   */
  async getAttributes() {
    // Reuse the DataQueue getAttributes logic
    const dq = new DataQueue(this.#system, this.#path);
    return dq.getAttributes();
  }

  /**
   * Internal read/peek implementation for keyed queues.
   */
  async #readInternal(key, wait, searchType, peek) {
    const search = (searchType ?? 'EQ').toUpperCase();
    const validSearches = ['EQ', 'NE', 'LT', 'LE', 'GT', 'GE'];
    if (!validSearches.includes(search)) {
      throw new Error(`Invalid search type: ${searchType}. Must be one of ${validSearches.join(', ')}`);
    }

    const { connection, ccsid } = await ensureDQConnection(this.#system);
    const queueName = padName(this.#name, ccsid);
    const libName = padName(this.#library, ccsid);
    const keyData = this.#toKeyBuffer(key, ccsid);

    // Convert search type to EBCDIC 2 bytes
    const conv = new CharConverter(ccsid);
    const searchBytes = conv.stringToByteArray(search.substring(0, 2));

    // 48 base + 6 + keyLen
    const totalLen = 54 + keyData.length;
    const buf = Buffer.alloc(totalLen);

    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(DQ_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(28, 16);
    buf.writeUInt16BE(REQ_READ, 18);

    queueName.copy(buf, 20);
    libName.copy(buf, 30);
    buf[40] = QT_KEYED;
    searchBytes.copy(buf, 41, 0, 2);
    buf.writeInt32BE(wait < 0 ? -1 : wait, 43);
    buf[47] = peek ? PEEK_YES : PEEK_NO;

    // Key LL/CP
    buf.writeUInt32BE(6 + keyData.length, 48);
    buf.writeUInt16BE(CP_KEY, 52);
    keyData.copy(buf, 54);

    const reply = await connection.sendAndReceive(buf);
    const repId = reply.readUInt16BE(18);

    if (repId === REP_COMMON) {
      const { rc } = parseCommonReply(reply);
      if (rc === RC_NO_DATA) return null;
      throw new AS400Error(`Keyed data queue read failed (RC=0x${rc.toString(16)})`, {
        returnCode: rc,
        hostService: 'DATAQUEUE',
      });
    }

    const { entry, key: returnedKey, senderInfo } = parseReadReply(reply);
    if (!entry) return null;

    return new KeyedDataQueueEntry(entry, returnedKey, senderInfo);
  }

  /**
   * Convert key to buffer.
   */
  #toKeyBuffer(key, ccsid) {
    if (Buffer.isBuffer(key)) return key;
    if (key instanceof Uint8Array) return Buffer.from(key);
    if (typeof key === 'string') {
      const conv = new CharConverter(ccsid);
      return Buffer.from(conv.stringToByteArray(key));
    }
    throw new Error('Key must be a string, Buffer, or Uint8Array');
  }
}
