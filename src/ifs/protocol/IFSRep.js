/**
 * IFS datastream reply parsers.
 *
 * Parses reply buffers from the IFS file server for all operations.
 *
 * Reply IDs are the request ID | 0x8000:
 *   Open:       0x8002   ListAttrs:  0x800A
 *   Read:       0x8003   ChangeAttrs:0x800B
 *   Write:      0x8004   DeleteFile: 0x800C
 *   Close:      0x8009   CreateDir:  0x800D
 *   Lookup:     0x800C   DeleteDir:  0x800E
 *   Copy:       0x8001   Rename:     0x800F
 *   ReturnCode: used by close, delete, create dir, etc.
 *
 * Upstream: IFSOpenRep.java, IFSReadRep.java, IFSWriteRep.java,
 *           IFSListAttrsRep.java, IFSLookupRep.java,
 *           IFSReturnCodeRep.java
 * @module ifs/protocol/IFSRep
 */

import { DatastreamError } from '../../core/errors.js';
import { CharConverter } from '../../ccsid/CharConverter.js';
import { CP_FILE_NAME, CP_OA1, CP_OA2 } from './IFSReq.js';

/** Reply IDs. */
export const REP_COPY         = 0x8001;
export const REP_OPEN         = 0x8002;
export const REP_READ         = 0x8003;
export const REP_WRITE        = 0x8004;
export const REP_LIST_ATTRS   = 0x800A;
export const REP_CLOSE        = 0x8009;
export const REP_CHANGE_ATTRS = 0x800B;
export const REP_DELETE_FILE  = 0x800C;
export const REP_CREATE_DIR   = 0x800D;
export const REP_DELETE_DIR   = 0x800E;
export const REP_RENAME       = 0x800F;
export const REP_LOOKUP       = 0x800C;

/** IFS return codes. */
export const RC_SUCCESS             = 0;
export const RC_FILE_IN_USE         = 1;
export const RC_FILE_NOT_FOUND      = 2;
export const RC_PATH_NOT_FOUND      = 3;
export const RC_DUPLICATE_DIR_ENTRY = 4;
export const RC_ACCESS_DENIED       = 5;
export const RC_INVALID_HANDLE      = 6;
export const RC_INVALID_NAME        = 7;
export const RC_DIR_NOT_EMPTY       = 9;
export const RC_RESOURCE_LIMIT      = 11;
export const RC_RESOURCE_NOT_AVAIL  = 12;
export const RC_REQUEST_DENIED      = 13;
export const RC_DIR_ENTRY_DAMAGED   = 14;
export const RC_NO_MORE_FILES       = 18;
export const RC_NO_MORE_DATA        = 22;
export const RC_SHARING_VIOLATION   = 32;
export const RC_LOCK_VIOLATION      = 33;
export const RC_STALE_HANDLE        = 34;

/** Object type constants from list attrs. */
export const OBJ_TYPE_FILE      = 1;
export const OBJ_TYPE_DIRECTORY = 2;
export const OBJ_TYPE_SYMLINK   = 3;

/**
 * Read an 8-byte IBM timestamp and return a Date.
 * Format: seconds since epoch (4 bytes BE) + microseconds (4 bytes BE).
 * @param {Buffer} buf
 * @param {number} off
 * @returns {Date}
 */
function readDate(buf, off) {
  if (off + 8 > buf.length) return new Date(0);
  const secs = buf.readUInt32BE(off);
  const micros = buf.readUInt32BE(off + 4);
  return new Date(secs * 1000 + Math.floor(micros / 1000));
}

/**
 * Parse LL/CP items from a buffer starting at `start` up to `end`.
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {Map<number, Buffer[]>}
 */
function parseCodePoints(buf, start, end) {
  const map = new Map();
  let offset = start;
  while (offset + 6 <= end) {
    const ll = buf.readUInt32BE(offset);
    if (ll < 6 || offset + ll > end) break;
    const cp = buf.readUInt16BE(offset + 4);
    const data = buf.subarray(offset + 6, offset + ll);
    if (!map.has(cp)) map.set(cp, []);
    map.get(cp).push(data);
    offset += ll;
  }
  return map;
}

export class IFSRep {

  /**
   * Get the reply request ID from a raw buffer.
   * @param {Buffer} buf
   * @returns {number}
   */
  static getReplyId(buf) {
    if (!buf || buf.length < 20) return 0;
    return buf.readUInt16BE(18);
  }

  /**
   * Parse a simple return code reply.
   * Used by: close, delete file, create dir, delete dir, rename, copy, change attrs.
   *
   * @param {Buffer} buf
   * @returns {{ returnCode: number }}
   */
  static parseReturnCode(buf) {
    if (!buf || buf.length < 22) {
      throw new DatastreamError('IFS return code reply too short');
    }
    return { returnCode: buf.readUInt16BE(20) };
  }

  /**
   * Parse an Open File reply (0x8002).
   *
   * @param {Buffer} buf
   * @returns {{
   *   returnCode: number,
   *   fileHandle: number,
   *   fileId: number,
   *   fileDataCCSID: number,
   *   actionTaken: number,
   *   createDate: Date,
   *   modifyDate: Date,
   *   accessDate: Date,
   *   fileSize: number,
   *   fixedAttrs: number,
   *   version: number,
   * }}
   */
  static parseOpen(buf) {
    if (!buf || buf.length < 22) {
      throw new DatastreamError('IFS open reply too short');
    }

    // Check if this is actually a return code reply (error case)
    const reqRepId = buf.readUInt16BE(18);
    const templateLen = buf.readUInt16BE(16);

    // Return code is at template[0..1] in the return code reply
    if (templateLen <= 2) {
      return {
        returnCode: buf.readUInt16BE(20),
        fileHandle: 0,
        fileId: 0,
        fileDataCCSID: 0,
        actionTaken: 0,
        createDate: new Date(0),
        modifyDate: new Date(0),
        accessDate: new Date(0),
        fileSize: 0,
        fixedAttrs: 0,
        version: 0,
      };
    }

    let off = 20;
    // Skip chain indicator (2 bytes)
    off += 2;

    const fileHandle = buf.readUInt32BE(off); off += 4;
    const fileId = buf.readUInt32BE(off); off += 4;

    // Skip 4 bytes (additional file ID fields)
    off += 4;

    const fileDataCCSID = buf.readUInt16BE(off); off += 2;
    const actionTaken = buf.readUInt16BE(off); off += 2;
    const createDate = readDate(buf, off); off += 8;
    const modifyDate = readDate(buf, off); off += 8;
    const accessDate = readDate(buf, off); off += 8;

    let fileSize = 0;
    const oldSize = buf.readUInt32BE(off); off += 4;
    const fixedAttrs = buf.readUInt32BE(off); off += 4;

    // Skip needExtAttrs (2) + numExtAttrs (2) + eaNameBytes (4) + eaValueBytes (4)
    off += 12;

    const version = off + 4 <= buf.length ? buf.readUInt32BE(off) : 0;
    off += 4;

    // Amount accessed + access history
    off += 5;

    // Check for large file size (DSL >= 16)
    if (off + 8 <= buf.length && oldSize === 0) {
      const hi = buf.readUInt32BE(off);
      const lo = buf.readUInt32BE(off + 4);
      fileSize = hi * 0x100000000 + lo;
    } else {
      fileSize = oldSize;
    }

    return {
      returnCode: 0,
      fileHandle,
      fileId,
      fileDataCCSID,
      actionTaken,
      createDate,
      modifyDate,
      accessDate,
      fileSize,
      fixedAttrs,
      version,
    };
  }

  /**
   * Parse a Read reply (0x8003).
   *
   * @param {Buffer} buf
   * @returns {{ returnCode: number, ccsid: number, data: Buffer }}
   */
  static parseRead(buf) {
    if (!buf || buf.length < 22) {
      throw new DatastreamError('IFS read reply too short');
    }

    const reqRepId = buf.readUInt16BE(18);
    const templateLen = buf.readUInt16BE(16);

    // Check if this is a return code reply (end of file / error)
    if (templateLen <= 2) {
      const rc = buf.readUInt16BE(20);
      return { returnCode: rc, ccsid: 0, data: Buffer.alloc(0) };
    }

    let off = 20;
    // Skip chain indicator (2 bytes)
    off += 2;

    const ccsid = buf.readUInt16BE(off); off += 2;

    // File data LL/CP follows
    if (off + 6 <= buf.length) {
      const ll = buf.readUInt32BE(off);
      const data = buf.subarray(off + 6, off + ll);
      return { returnCode: 0, ccsid, data };
    }

    return { returnCode: 0, ccsid, data: Buffer.alloc(0) };
  }

  /**
   * Parse a Write reply (0x8004).
   * May come as a return code reply instead.
   *
   * @param {Buffer} buf
   * @returns {{ returnCode: number, previousFileSize: number, bytesNotWritten: number }}
   */
  static parseWrite(buf) {
    if (!buf || buf.length < 22) {
      throw new DatastreamError('IFS write reply too short');
    }

    const templateLen = buf.readUInt16BE(16);

    if (templateLen <= 2) {
      return {
        returnCode: buf.readUInt16BE(20),
        previousFileSize: 0,
        bytesNotWritten: 0,
      };
    }

    let off = 20;
    off += 2; // chain indicator
    const returnCode = buf.readUInt16BE(off); off += 2;
    const previousFileSize = off + 4 <= buf.length ? buf.readUInt32BE(off) : 0; off += 4;
    const bytesNotWritten = off + 4 <= buf.length ? buf.readUInt32BE(off) : 0;

    return { returnCode, previousFileSize, bytesNotWritten };
  }

  /**
   * Parse a List Attributes reply (0x800A).
   * Each reply may contain one directory entry. Multiple replies may be returned.
   *
   * @param {Buffer} buf
   * @returns {{
   *   returnCode: number,
   *   entry: {
   *     name: string,
   *     createDate: Date,
   *     modifyDate: Date,
   *     accessDate: Date,
   *     fileSize: number,
   *     fixedAttrs: number,
   *     objectType: number,
   *     isDirectory: boolean,
   *     isFile: boolean,
   *     isSymlink: boolean,
   *     nameCCSID: number,
   *   } | null,
   * }}
   */
  static parseListAttrs(buf) {
    if (!buf || buf.length < 22) {
      throw new DatastreamError('IFS list attrs reply too short');
    }

    const templateLen = buf.readUInt16BE(16);
    const totalLen = buf.readUInt32BE(0);

    // Return code reply (no more entries)
    if (templateLen <= 2) {
      return { returnCode: buf.readUInt16BE(20), entry: null };
    }

    let off = 20;
    // Skip chain indicator
    off += 2;

    const createDate = readDate(buf, off); off += 8;
    const modifyDate = readDate(buf, off); off += 8;
    const accessDate = readDate(buf, off); off += 8;

    const fileSize4 = buf.readUInt32BE(off); off += 4;
    const fixedAttrs = buf.readUInt32BE(off); off += 4;
    const objectType = buf.readUInt16BE(off); off += 2;

    // numExtAttrs (2) + eaNameBytes (2)
    off += 4;
    // eaValueBytes (4) + version (4) + amountAccessed (4) + accessHistory (1)
    off += 13;

    const nameCCSID = off + 2 <= buf.length ? buf.readUInt16BE(off) : UCS2_CCSID;
    off += 2;

    // checkoutCCSID (2) + restartID (1)
    off += 3;

    let fileSize = fileSize4;
    // Large file size (8 bytes) if DSL >= 8
    if (off + 8 <= 20 + templateLen) {
      const hi = buf.readUInt32BE(off);
      const lo = buf.readUInt32BE(off + 4);
      if (hi > 0 || fileSize4 === 0) {
        fileSize = hi * 0x100000000 + lo;
      }
      off += 8;
    }

    // Parse LL/CP items (file name, OA1, OA2)
    const cpStart = 20 + templateLen;
    const codePoints = parseCodePoints(buf, cpStart, totalLen);

    // Extract file name
    let name = '';
    const nameItems = codePoints.get(CP_FILE_NAME);
    if (nameItems && nameItems.length > 0) {
      const nameBuf = nameItems[0];
      try {
        const conv = new CharConverter(nameCCSID || 13488);
        name = conv.byteArrayToString(nameBuf, 0, nameBuf.length);
      } catch {
        name = nameBuf.toString('utf-8');
      }
    }

    const isDirectory = objectType === OBJ_TYPE_DIRECTORY ||
                        (fixedAttrs & FA_DIRECTORY) !== 0;

    return {
      returnCode: 0,
      entry: {
        name,
        createDate,
        modifyDate,
        accessDate,
        fileSize,
        fixedAttrs,
        objectType,
        isDirectory,
        isFile: objectType === OBJ_TYPE_FILE,
        isSymlink: objectType === OBJ_TYPE_SYMLINK,
        nameCCSID,
      },
    };
  }

  /**
   * Parse a Lookup reply.
   * The lookup reply is essentially a return code reply with optional OA1/OA2 code points.
   *
   * @param {Buffer} buf
   * @returns {{
   *   returnCode: number,
   *   objectHandle: number,
   *   codePoints: Map<number, Buffer[]>,
   * }}
   */
  static parseLookup(buf) {
    if (!buf || buf.length < 22) {
      throw new DatastreamError('IFS lookup reply too short');
    }

    const totalLen = buf.readUInt32BE(0);
    const templateLen = buf.readUInt16BE(16);

    if (templateLen <= 2) {
      return {
        returnCode: buf.readUInt16BE(20),
        objectHandle: 0,
        codePoints: new Map(),
      };
    }

    let off = 20;
    off += 2; // chain indicator
    const objectHandle = off + 4 <= buf.length ? buf.readUInt32BE(off) : 0;

    const cpStart = 20 + templateLen;
    const codePoints = parseCodePoints(buf, cpStart, totalLen);

    return { returnCode: 0, objectHandle, codePoints };
  }

  /**
   * Return a human-readable message for a return code.
   * @param {number} rc
   * @returns {string}
   */
  static returnCodeMessage(rc) {
    switch (rc) {
      case RC_SUCCESS: return 'Success';
      case RC_FILE_IN_USE: return 'File in use';
      case RC_FILE_NOT_FOUND: return 'File not found';
      case RC_PATH_NOT_FOUND: return 'Path not found';
      case RC_DUPLICATE_DIR_ENTRY: return 'Directory entry already exists';
      case RC_ACCESS_DENIED: return 'Access denied';
      case RC_INVALID_HANDLE: return 'Invalid handle';
      case RC_INVALID_NAME: return 'Invalid name';
      case RC_DIR_NOT_EMPTY: return 'Directory not empty';
      case RC_RESOURCE_LIMIT: return 'Resource limit exceeded';
      case RC_RESOURCE_NOT_AVAIL: return 'Resource not available';
      case RC_REQUEST_DENIED: return 'Request denied';
      case RC_DIR_ENTRY_DAMAGED: return 'Directory entry damaged';
      case RC_NO_MORE_FILES: return 'No more files';
      case RC_NO_MORE_DATA: return 'No more data';
      case RC_SHARING_VIOLATION: return 'Sharing violation';
      case RC_LOCK_VIOLATION: return 'Lock violation';
      case RC_STALE_HANDLE: return 'Stale handle';
      default: return `Unknown error (${rc})`;
    }
  }
}

const FA_DIRECTORY = 0x10;
const UCS2_CCSID = 13488;
