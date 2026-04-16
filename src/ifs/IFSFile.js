/**
 * IFS file metadata, listing, and CRUD operations.
 *
 * Provides a high-level API for IFS file system operations using the
 * IBM i file host server protocol (Service.FILE / port 8473).
 *
 * A separate Java-only adapter that mirrored `java.io.File` on IFS is
 * intentionally not ported because it adds no value in Node/Bun.
 *
 * Upstream: IFSFile.java, IFSFileImplRemote.java
 * @module ifs/IFSFile
 */

import { Service } from '../core/constants.js';
import { AS400Error } from '../core/errors.js';
import { SeedExchange } from '../transport/SeedExchange.js';
import { ServerStart } from '../transport/ServerStart.js';
import { ServiceToServerID } from '../core/constants.js';
import { IFSReq, ACCESS_READ, ACCESS_WRITE, SHARE_DENY_NONE,
  OPEN_FAIL_OPEN, OPEN_CREATE_OPEN, OPEN_CREATE_FAIL,
  CONVERT_NONE, OA_LEVEL1 } from './protocol/IFSReq.js';
import { IFSRep, RC_SUCCESS, RC_FILE_NOT_FOUND, RC_PATH_NOT_FOUND,
  RC_NO_MORE_FILES, RC_NO_MORE_DATA, RC_DUPLICATE_DIR_ENTRY } from './protocol/IFSRep.js';

const FILE_SERVER_ID = ServiceToServerID[Service.FILE];

/**
 * Ensure the file service connection is established and authenticated.
 * @param {import('../core/AS400.js').AS400} system
 * @returns {Promise<import('../transport/Connection.js').Connection>}
 */
async function ensureConnection(system) {
  const conn = await system.connectService(Service.FILE);

  if (!system.getServerAttributes(Service.FILE)) {
    // Perform seed exchange + server start for the file server
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

/**
 * Send a request and receive a reply via the file service connection.
 * @param {import('../core/AS400.js').AS400} system
 * @param {Buffer} reqBuf
 * @returns {Promise<Buffer>}
 */
async function sendRequest(system, reqBuf) {
  const conn = await ensureConnection(system);
  return conn.sendAndReceive(reqBuf);
}

/**
 * Throw an AS400Error for an IFS return code.
 * @param {number} rc
 * @param {string} path
 * @param {string} operation
 */
function throwIfError(rc, path, operation) {
  if (rc !== RC_SUCCESS) {
    throw new AS400Error(
      `IFS ${operation} failed: ${IFSRep.returnCodeMessage(rc)} (rc=${rc}) path='${path}'`,
      { returnCode: rc, hostService: 'FILE' }
    );
  }
}

export class IFSFile {
  /** @type {import('../core/AS400.js').AS400} */
  #system;
  /** @type {string} */
  #path;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - Full IFS path (e.g. "/home/myuser/test.txt")
   */
  constructor(system, path) {
    this.#system = system;
    this.#path = path;
  }

  get system() { return this.#system; }
  get path() { return this.#path; }

  /**
   * Get the file name (last component of the path).
   * @returns {string}
   */
  getName() {
    const parts = this.#path.split('/');
    return parts[parts.length - 1] || '';
  }

  /**
   * Get the parent path.
   * @returns {string}
   */
  getParent() {
    const idx = this.#path.lastIndexOf('/');
    if (idx <= 0) return '/';
    return this.#path.substring(0, idx);
  }

  /**
   * Get the full IFS path.
   * @returns {string}
   */
  getPath() { return this.#path; }

  /**
   * Check if the file or directory exists.
   * @returns {Promise<boolean>}
   */
  async exists() {
    try {
      const attrs = await this.#listSelf();
      return attrs !== null;
    } catch {
      return false;
    }
  }

  /**
   * Check if this path is a directory.
   * @returns {Promise<boolean>}
   */
  async isDirectory() {
    const attrs = await this.#listSelf();
    return attrs?.isDirectory ?? false;
  }

  /**
   * Check if this path is a regular file.
   * @returns {Promise<boolean>}
   */
  async isFile() {
    const attrs = await this.#listSelf();
    return attrs?.isFile ?? false;
  }

  /**
   * Check if this path is a symbolic link.
   * @returns {Promise<boolean>}
   */
  async isSymbolicLink() {
    const attrs = await this.#listSelf();
    return attrs?.isSymlink ?? false;
  }

  /**
   * Get the file size in bytes.
   * @returns {Promise<number>}
   */
  async length() {
    const attrs = await this.#listSelf();
    return attrs?.fileSize ?? 0;
  }

  /**
   * Get the last modified date.
   * @returns {Promise<Date>}
   */
  async lastModified() {
    const attrs = await this.#listSelf();
    return attrs?.modifyDate ?? new Date(0);
  }

  /**
   * Get the creation date.
   * @returns {Promise<Date>}
   */
  async created() {
    const attrs = await this.#listSelf();
    return attrs?.createDate ?? new Date(0);
  }

  /**
   * Get the last access date.
   * @returns {Promise<Date>}
   */
  async lastAccessed() {
    const attrs = await this.#listSelf();
    return attrs?.accessDate ?? new Date(0);
  }

  /**
   * List the names of files and directories in this directory.
   * @param {string} [filter='*'] - Wildcard pattern (default: all)
   * @returns {Promise<string[]>}
   */
  async list(filter = '*') {
    const entries = await this.listFiles(filter);
    return entries.map(e => e.name);
  }

  /**
   * List files and directories with full attribute information.
   * @param {string} [filter='*'] - Wildcard pattern
   * @returns {Promise<Array<{ name: string, fileSize: number, isDirectory: boolean, isFile: boolean, isSymlink: boolean, modifyDate: Date, createDate: Date, accessDate: Date }>>}
   */
  async listFiles(filter = '*') {
    let listPath = this.#path;
    if (!listPath.endsWith('/')) listPath += '/';
    listPath += filter;

    const entries = [];
    const conn = await ensureConnection(this.#system);

    const reqBuf = IFSReq.buildListAttrs({ fileName: listPath });
    await conn.send(reqBuf);

    // Receive multiple replies (one per entry, terminated by RC_NO_MORE_FILES)
    while (true) {
      const replyBuf = await conn.receive();
      const result = IFSRep.parseListAttrs(replyBuf);

      if (result.entry) {
        entries.push(result.entry);
      }

      if (result.returnCode === RC_NO_MORE_FILES || result.returnCode === RC_NO_MORE_DATA) {
        break;
      }
      if (result.returnCode !== RC_SUCCESS && !result.entry) {
        break;
      }
    }

    return entries;
  }

  /**
   * Create a new empty file. Fails if the file already exists.
   * @returns {Promise<boolean>} true if created
   */
  async createNewFile() {
    const reqBuf = IFSReq.buildOpen({
      fileName: this.#path,
      accessIntent: ACCESS_WRITE,
      openOption: OPEN_CREATE_FAIL,
      createSize: 0,
    });
    const replyBuf = await sendRequest(this.#system, reqBuf);
    const result = IFSRep.parseOpen(replyBuf);

    if (result.returnCode === RC_DUPLICATE_DIR_ENTRY) {
      return false;
    }
    if (result.returnCode !== RC_SUCCESS) {
      throwIfError(result.returnCode, this.#path, 'createNewFile');
    }

    // Close the handle
    if (result.fileHandle) {
      const closeBuf = IFSReq.buildClose({ fileHandle: result.fileHandle });
      const closeReply = await sendRequest(this.#system, closeBuf);
      IFSRep.parseReturnCode(closeReply);
    }

    return true;
  }

  /**
   * Delete the file or empty directory.
   * @returns {Promise<boolean>} true if deleted
   */
  async delete() {
    const isDir = await this.isDirectory();
    let reqBuf;
    if (isDir) {
      reqBuf = IFSReq.buildDeleteDir({ dirName: this.#path });
    } else {
      reqBuf = IFSReq.buildDeleteFile({ fileName: this.#path });
    }

    const replyBuf = await sendRequest(this.#system, reqBuf);
    const result = IFSRep.parseReturnCode(replyBuf);

    if (result.returnCode === RC_FILE_NOT_FOUND || result.returnCode === RC_PATH_NOT_FOUND) {
      return false;
    }
    throwIfError(result.returnCode, this.#path, 'delete');
    return true;
  }

  /**
   * Create a directory.
   * @returns {Promise<boolean>} true if created
   */
  async mkdir() {
    const reqBuf = IFSReq.buildCreateDir({ dirName: this.#path });
    const replyBuf = await sendRequest(this.#system, reqBuf);
    const result = IFSRep.parseReturnCode(replyBuf);

    if (result.returnCode === RC_DUPLICATE_DIR_ENTRY) {
      return false;
    }
    if (result.returnCode !== RC_SUCCESS) {
      throwIfError(result.returnCode, this.#path, 'mkdir');
    }
    return true;
  }

  /**
   * Create a directory and all necessary parent directories.
   * @returns {Promise<boolean>} true if created (or already existed)
   */
  async mkdirs() {
    const parts = this.#path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      const reqBuf = IFSReq.buildCreateDir({ dirName: current });
      const replyBuf = await sendRequest(this.#system, reqBuf);
      const result = IFSRep.parseReturnCode(replyBuf);
      if (result.returnCode !== RC_SUCCESS && result.returnCode !== RC_DUPLICATE_DIR_ENTRY) {
        throwIfError(result.returnCode, current, 'mkdirs');
      }
    }
    return true;
  }

  /**
   * Rename this file or directory.
   * @param {IFSFile|string} target - New path
   * @returns {Promise<boolean>}
   */
  async renameTo(target) {
    const targetPath = typeof target === 'string' ? target : target.path;
    const reqBuf = IFSReq.buildRename({
      sourceName: this.#path,
      targetName: targetPath,
    });
    const replyBuf = await sendRequest(this.#system, reqBuf);
    const result = IFSRep.parseReturnCode(replyBuf);
    throwIfError(result.returnCode, this.#path, 'renameTo');
    this.#path = targetPath;
    return true;
  }

  /**
   * Copy this file to a target path.
   * @param {string} targetPath
   * @param {object} [opts]
   * @param {boolean} [opts.replace=false]
   * @returns {Promise<void>}
   */
  async copyTo(targetPath, opts = {}) {
    const reqBuf = IFSReq.buildCopy({
      sourceName: this.#path,
      targetName: targetPath,
      replace: opts.replace ?? false,
    });
    const replyBuf = await sendRequest(this.#system, reqBuf);
    const result = IFSRep.parseReturnCode(replyBuf);
    throwIfError(result.returnCode, this.#path, 'copyTo');
  }

  /**
   * Set the last modified date.
   * @param {Date|number} date - Date object or milliseconds since epoch
   * @returns {Promise<void>}
   */
  async setLastModified(date) {
    const d = typeof date === 'number' ? new Date(date) : date;
    const reqBuf = IFSReq.buildChangeAttrs({
      fileName: this.#path,
      modifyDate: d,
    });
    const replyBuf = await sendRequest(this.#system, reqBuf);
    const result = IFSRep.parseReturnCode(replyBuf);
    throwIfError(result.returnCode, this.#path, 'setLastModified');
  }

  /**
   * Get file attributes by listing the file itself.
   * @returns {Promise<object|null>}
   */
  async #listSelf() {
    const conn = await ensureConnection(this.#system);

    const reqBuf = IFSReq.buildListAttrs({
      fileName: this.#path,
      maxGetCount: 1,
    });
    await conn.send(reqBuf);

    const replyBuf = await conn.receive();
    const result = IFSRep.parseListAttrs(replyBuf);

    if (result.entry) {
      // Consume the "no more files" terminator reply
      try {
        const termBuf = await conn.receive();
      } catch { /* ignore timeout on terminator */ }
      return result.entry;
    }

    if (result.returnCode === RC_FILE_NOT_FOUND || result.returnCode === RC_PATH_NOT_FOUND) {
      return null;
    }

    if (result.returnCode !== RC_SUCCESS && result.returnCode !== RC_NO_MORE_FILES) {
      return null;
    }

    return null;
  }
}
