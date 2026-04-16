/**
 * IFS datastream request builders.
 *
 * Builds the wire-format request buffers for all IFS file server operations.
 * Each static method returns a complete datastream Buffer ready to send.
 *
 * The IFS file server uses ServerID 0xE002 and its own set of request IDs.
 *
 * Upstream: IFSOpenReq.java, IFSCloseReq.java, IFSReadReq.java,
 *           IFSWriteReq.java, IFSLookupReq.java, IFSListAttrsReq.java,
 *           IFSCreateDirReq.java, IFSDeleteDirReq.java, IFSDeleteFileReq.java,
 *           IFSRenameReq.java, IFSCopyReq.java, IFSChangeAttrsReq.java,
 *           IFSLockBytesReq.java, IFSUnlockBytesReq.java,
 *           IFSUserHandleSeedReq.java, IFSDataStreamReq.java
 * @module ifs/protocol/IFSReq
 */

import { ServerID } from '../../core/constants.js';
import { DataStream } from '../../transport/DataStream.js';
import { CharConverter } from '../../ccsid/CharConverter.js';

const FILE_SERVER_ID = ServerID.FILE; // 0xE002

/** Request IDs. */
export const REQ_COPY           = 0x0001;
export const REQ_OPEN           = 0x0002;
export const REQ_READ           = 0x0003;
export const REQ_WRITE          = 0x0004;
export const REQ_LIST_ATTRS     = 0x000A;
export const REQ_QUERY_SPACE    = 0x0006;
export const REQ_LOCK_BYTES     = 0x0007;
export const REQ_UNLOCK_BYTES   = 0x0008;
export const REQ_CLOSE          = 0x0009;
export const REQ_CHANGE_ATTRS   = 0x000B;
export const REQ_DELETE_FILE    = 0x000C;
export const REQ_CREATE_DIR     = 0x000D;
export const REQ_DELETE_DIR     = 0x000E;
export const REQ_RENAME         = 0x000F;
export const REQ_FREE_HANDLE    = 0x0015;
export const REQ_LOOKUP         = 0x001A;
export const REQ_USER_HANDLE_SEED = 0x0023;
export const REQ_USER_HANDLE2   = 0x002B;

/** Code points for LL/CP items. */
export const CP_DIR_NAME        = 0x0001;
export const CP_FILE_NAME       = 0x0002;
export const CP_SOURCE_NAME     = 0x0003;
export const CP_TARGET_NAME     = 0x0004;
export const CP_RESTART_NAME    = 0x0007;
export const CP_EA_LIST_HEADER  = 0x0008;
export const CP_EA_LIST         = 0x0009;
export const CP_RESTART_ID      = 0x000E;
export const CP_OA2             = 0x000F;
export const CP_OA1             = 0x0010;
export const CP_SERVER_TICKET   = 0x0013;
export const CP_AUTH_FACTOR     = 0x0015;
export const CP_FILE_DATA       = 0x0020;

/** Access intent flags. */
export const ACCESS_READ        = 0x0001;
export const ACCESS_WRITE       = 0x0002;
export const ACCESS_EXEC        = 0x0004;

/** Share mode flags. */
export const SHARE_DENY_NONE    = 0x0000;
export const SHARE_DENY_READERS = 0x0001;
export const SHARE_DENY_WRITERS = 0x0002;
export const SHARE_DENY_ALL     = 0x0003;

/** Data conversion modes. */
export const CONVERT_NONE       = 0x0000;
export const CONVERT_CLIENT     = 0x0001;
export const CONVERT_SERVER     = 0x0002;

/** Open options (duplicate file handling). */
export const OPEN_CREATE_OPEN    = 0x0001;
export const OPEN_CREATE_REPLACE = 0x0002;
export const OPEN_CREATE_FAIL    = 0x0004;
export const OPEN_FAIL_OPEN      = 0x0008;
export const OPEN_FAIL_REPLACE   = 0x0010;

/** File attribute flags. */
export const FA_READONLY  = 0x01;
export const FA_HIDDEN    = 0x02;
export const FA_SYSTEM    = 0x04;
export const FA_DIRECTORY = 0x10;
export const FA_ARCHIVE   = 0x20;

/** Authority check flags for list attrs. */
export const AUTH_NONE    = 0x0000;
export const AUTH_READ    = 0x0001;
export const AUTH_WRITE   = 0x0002;
export const AUTH_EXEC    = 0x0004;

/** Pattern matching modes. */
export const PATTERN_POSIX   = 0x0000;
export const PATTERN_POSIX_ALL = 0x0001;
export const PATTERN_OS2     = 0x0002;

/** Attr list level values. */
export const OA_NONE  = 0x0000;
export const OA_LEVEL1 = 0x0001;
export const OA_LEVEL1_LARGE = 0x0101;
export const OA_LEVEL2 = 0x0002;
export const OA_LEVEL2_LARGE = 0x0004;
export const OA_LEVEL1_AND_2 = 0x0006;

/** Working directory handle for root "/". */
const ROOT_HANDLE = 1;

/** Default filename CCSID (UCS-2). */
const UCS2_CCSID = 13488;

/**
 * Encode a filename string to UCS-2 big-endian bytes.
 * @param {string} name
 * @returns {Buffer}
 */
function encodeUCS2(name) {
  return CharConverter.stringToByteArray(name, UCS2_CCSID);
}

/**
 * Encode a filename string to the given CCSID.
 * @param {string} name
 * @param {number} ccsid
 * @returns {Buffer}
 */
function encodeName(name, ccsid) {
  return CharConverter.stringToByteArray(name, ccsid);
}

/**
 * Write the standard 20-byte header.
 */
function writeHeader(buf, totalLen, reqId, correlation) {
  buf.writeUInt32BE(totalLen, 0);
  buf.writeUInt16BE(0, 4);              // header ID
  buf.writeUInt16BE(FILE_SERVER_ID, 6); // server ID
  buf.writeUInt32BE(0, 8);              // CS instance
  buf.writeUInt32BE(correlation, 12);
  // templateLen and reqRepId written by caller after this
}

export class IFSReq {

  /**
   * Build an Open File request.
   *
   * @param {object} opts
   * @param {string} opts.fileName - Full IFS path
   * @param {number} [opts.fileNameCCSID=13488] - CCSID for filename encoding
   * @param {number} [opts.fileDataCCSID=0xFFFF] - CCSID for file data
   * @param {number} [opts.accessIntent=ACCESS_READ] - Read/write access flags
   * @param {number} [opts.shareMode=SHARE_DENY_NONE]
   * @param {number} [opts.dataConversion=CONVERT_NONE]
   * @param {number} [opts.openOption=OPEN_FAIL_OPEN] - Open/create behavior
   * @param {number} [opts.createSize=0] - Initial file size on create
   * @param {number} [opts.fixedAttrs=0] - File attribute flags
   * @param {number} [opts.attrListLevel=OA_LEVEL1]
   * @param {number} [opts.datastreamLevel=16] - Negotiated DSL
   * @returns {Buffer}
   */
  static buildOpen(opts) {
    const {
      fileName,
      fileNameCCSID = UCS2_CCSID,
      fileDataCCSID = 0xFFFF,
      accessIntent = ACCESS_READ,
      shareMode = SHARE_DENY_NONE,
      dataConversion = CONVERT_NONE,
      openOption = OPEN_FAIL_OPEN,
      createSize = 0,
      fixedAttrs = 0,
      attrListLevel = OA_LEVEL1,
      datastreamLevel = 16,
    } = opts;

    const nameBytes = encodeName(fileName, fileNameCCSID);
    const useLarge = datastreamLevel >= 16;
    const templateLen = useLarge ? 44 : 36;
    const nameLLCP = 6 + nameBytes.length; // LL(4) + CP(2) + data
    const totalLen = 20 + templateLen + nameLLCP;

    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_OPEN, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_OPEN, 18);

    let off = 20;
    // Chain indicator (2 bytes) - 0 = end of chain
    buf.writeUInt16BE(0, off); off += 2;
    // File name CCSID
    buf.writeUInt16BE(fileNameCCSID, off); off += 2;
    // Working dir handle
    buf.writeUInt32BE(ROOT_HANDLE, off); off += 4;
    // File data CCSID
    buf.writeUInt16BE(fileDataCCSID, off); off += 2;
    // Access intent
    buf.writeUInt16BE(accessIntent, off); off += 2;
    // Share mode
    buf.writeUInt16BE(shareMode, off); off += 2;
    // Data conversion
    buf.writeUInt16BE(dataConversion, off); off += 2;
    // Duplicate file option (open option)
    buf.writeUInt16BE(openOption, off); off += 2;
    // Create size (4-byte, must be 0 if large)
    buf.writeUInt32BE(useLarge ? 0 : createSize, off); off += 4;
    // Fixed attributes
    buf.writeUInt32BE(fixedAttrs, off); off += 4;
    // Attr list level
    buf.writeUInt16BE(attrListLevel, off); off += 2;
    // Pre-read offset
    buf.writeUInt32BE(0, off); off += 4;
    // Pre-read length
    buf.writeUInt32BE(0, off); off += 4;

    if (useLarge) {
      // Large create size (8 bytes)
      buf.writeUInt32BE(0, off); off += 4;
      buf.writeUInt32BE(createSize, off); off += 4;
    }

    // File name LL/CP
    buf.writeUInt32BE(nameLLCP, off);
    buf.writeUInt16BE(CP_FILE_NAME, off + 4);
    nameBytes.copy(buf, off + 6);

    return buf;
  }

  /**
   * Build a Close File request.
   *
   * @param {object} opts
   * @param {number} opts.fileHandle
   * @returns {Buffer}
   */
  static buildClose(opts) {
    const { fileHandle } = opts;
    const templateLen = 22;
    const totalLen = 20 + templateLen;
    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_CLOSE, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_CLOSE, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;        // chain indicator
    buf.writeUInt32BE(fileHandle, off); off += 4; // file handle
    buf.writeUInt16BE(2, off); off += 2;        // data flags (2 = request reply)
    buf.writeUInt16BE(0xFFFF, off); off += 2;   // CCSID
    buf.writeUInt16BE(100, off); off += 2;      // amount accessed
    buf[off] = 0; off += 1;                     // access history
    // Modify date (8 bytes = 0)
    buf.fill(0, off, off + 8); off += 8;
    // One more pad byte
    buf[off] = 0;

    return buf;
  }

  /**
   * Build a Read File request.
   *
   * @param {object} opts
   * @param {number} opts.fileHandle
   * @param {number} opts.offset - File offset to read from
   * @param {number} opts.length - Number of bytes to read
   * @param {number} [opts.datastreamLevel=16]
   * @returns {Buffer}
   */
  static buildRead(opts) {
    const {
      fileHandle,
      offset: fileOffset,
      length: readLen,
      datastreamLevel = 16,
    } = opts;

    const useLarge = datastreamLevel >= 16;
    const templateLen = useLarge ? 38 : 22;
    const totalLen = 20 + templateLen;
    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_READ, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_READ, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;            // chain indicator
    buf.writeUInt32BE(fileHandle, off); off += 4;   // file handle
    buf.writeUInt32BE(0, off); off += 4;            // base offset
    if (useLarge) {
      buf.writeUInt32BE(0, off); off += 4;          // relative offset (4-byte, 0 for large)
      buf.writeUInt32BE(readLen, off); off += 4;    // read length
      buf.writeUInt32BE(0, off); off += 4;          // pre-read length
      // Large base offset (8 bytes)
      buf.writeUInt32BE(0, off); off += 4;
      buf.writeUInt32BE(0, off); off += 4;
      // Large relative offset (8 bytes)
      buf.writeUInt32BE(Math.floor(fileOffset / 0x100000000), off); off += 4;
      buf.writeUInt32BE(fileOffset >>> 0, off);
    } else {
      buf.writeUInt32BE(fileOffset, off); off += 4; // relative offset
      buf.writeUInt32BE(readLen, off); off += 4;    // read length
      buf.writeUInt32BE(0, off);                    // pre-read length
    }

    return buf;
  }

  /**
   * Build a Write File request.
   *
   * @param {object} opts
   * @param {number} opts.fileHandle
   * @param {number} opts.offset - File offset to write at
   * @param {Buffer} opts.data - Data to write
   * @param {number} [opts.ccsid=0xFFFF] - File data CCSID
   * @param {boolean} [opts.sync=false] - Force sync write
   * @param {number} [opts.datastreamLevel=16]
   * @returns {Buffer}
   */
  static buildWrite(opts) {
    const {
      fileHandle,
      offset: fileOffset,
      data,
      ccsid = 0xFFFF,
      sync = false,
      datastreamLevel = 16,
    } = opts;

    const useLarge = datastreamLevel >= 16;
    const templateLen = useLarge ? 34 : 18;
    const dataLLCP = 6 + data.length;
    const totalLen = 20 + templateLen + dataLLCP;
    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_WRITE, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_WRITE, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;             // chain indicator
    buf.writeUInt32BE(fileHandle, off); off += 4;    // file handle
    buf.writeUInt32BE(0, off); off += 4;             // base offset

    if (useLarge) {
      buf.writeUInt32BE(0, off); off += 4;           // relative offset (4-byte, 0 for large)
      buf.writeUInt16BE(sync ? 3 : 2, off); off += 2; // data flags
      buf.writeUInt16BE(ccsid, off); off += 2;       // CCSID
      // Large base offset (8 bytes)
      buf.writeUInt32BE(0, off); off += 4;
      buf.writeUInt32BE(0, off); off += 4;
      // Large relative offset (8 bytes)
      buf.writeUInt32BE(Math.floor(fileOffset / 0x100000000), off); off += 4;
      buf.writeUInt32BE(fileOffset >>> 0, off); off += 4;
    } else {
      buf.writeUInt32BE(fileOffset, off); off += 4;  // relative offset
      buf.writeUInt16BE(sync ? 3 : 2, off); off += 2; // data flags
      buf.writeUInt16BE(ccsid, off); off += 2;       // CCSID
    }

    // File data LL/CP
    buf.writeUInt32BE(dataLLCP, off);
    buf.writeUInt16BE(CP_FILE_DATA, off + 4);
    data.copy(buf, off + 6);

    return buf;
  }

  /**
   * Build a List Attributes request.
   *
   * @param {object} opts
   * @param {string} opts.fileName - IFS path (may include wildcards)
   * @param {number} [opts.fileNameCCSID=13488]
   * @param {number} [opts.fileHandle=0] - 0 = use path
   * @param {number} [opts.maxGetCount=0xFFFF] - Max entries to return (-1 = all)
   * @param {number} [opts.attrListLevel=OA_LEVEL1]
   * @param {number} [opts.patternMatching=PATTERN_POSIX]
   * @returns {Buffer}
   */
  static buildListAttrs(opts) {
    const {
      fileName,
      fileNameCCSID = UCS2_CCSID,
      fileHandle = 0,
      maxGetCount = 0xFFFF,
      attrListLevel = OA_LEVEL1,
      patternMatching = PATTERN_POSIX,
    } = opts;

    const nameBytes = encodeName(fileName, fileNameCCSID);
    const templateLen = 20;
    const nameLLCP = 6 + nameBytes.length;
    const totalLen = 20 + templateLen + nameLLCP;

    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_LIST_ATTRS, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_LIST_ATTRS, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;              // chain indicator
    buf.writeUInt32BE(fileHandle, off); off += 4;     // file handle
    buf.writeUInt16BE(fileNameCCSID, off); off += 2;  // CCSID
    buf.writeUInt32BE(ROOT_HANDLE, off); off += 4;    // working dir handle
    buf.writeUInt16BE(AUTH_NONE, off); off += 2;      // authority check
    buf.writeUInt16BE(maxGetCount, off); off += 2;    // max get count
    buf.writeUInt16BE(attrListLevel, off); off += 2;  // attr list level
    buf.writeUInt16BE(patternMatching, off);           // pattern matching

    // File name LL/CP
    off = 20 + templateLen;
    buf.writeUInt32BE(nameLLCP, off);
    buf.writeUInt16BE(CP_FILE_NAME, off + 4);
    nameBytes.copy(buf, off + 6);

    return buf;
  }

  /**
   * Build a Lookup (GetFileSystemInfo) request.
   *
   * @param {object} opts
   * @param {string} opts.fileName - IFS path
   * @param {number} [opts.fileNameCCSID=13488]
   * @param {number} [opts.attrListLevel=OA_LEVEL2]
   * @returns {Buffer}
   */
  static buildLookup(opts) {
    const {
      fileName,
      fileNameCCSID = UCS2_CCSID,
      attrListLevel = OA_LEVEL2,
    } = opts;

    const nameBytes = encodeName(fileName, fileNameCCSID);
    const templateLen = 22;
    const nameLLCP = 6 + nameBytes.length;
    const totalLen = 20 + templateLen + nameLLCP;

    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_LOOKUP, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_LOOKUP, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;              // chain indicator
    buf.writeUInt32BE(0, off); off += 4;              // parent handle
    buf.writeUInt32BE(0, off); off += 4;              // object handle
    buf.writeUInt16BE(fileNameCCSID, off); off += 2;  // CCSID
    buf.writeUInt32BE(0, off); off += 4;              // file mode
    buf.writeUInt16BE(attrListLevel, off); off += 2;  // attr list level
    buf.writeUInt32BE(0, off);                        // reserved

    // Object name LL/CP
    off = 20 + templateLen;
    buf.writeUInt32BE(nameLLCP, off);
    buf.writeUInt16BE(CP_FILE_NAME, off + 4);
    nameBytes.copy(buf, off + 6);

    return buf;
  }

  /**
   * Build a Delete File request.
   *
   * @param {object} opts
   * @param {string} opts.fileName
   * @param {number} [opts.fileNameCCSID=13488]
   * @returns {Buffer}
   */
  static buildDeleteFile(opts) {
    const { fileName, fileNameCCSID = UCS2_CCSID } = opts;
    const nameBytes = encodeName(fileName, fileNameCCSID);
    const templateLen = 8;
    const nameLLCP = 6 + nameBytes.length;
    const totalLen = 20 + templateLen + nameLLCP;

    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_DELETE_FILE, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_DELETE_FILE, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;              // chain indicator
    buf.writeUInt16BE(fileNameCCSID, off); off += 2;  // CCSID
    buf.writeUInt32BE(ROOT_HANDLE, off);              // working dir handle

    off = 20 + templateLen;
    buf.writeUInt32BE(nameLLCP, off);
    buf.writeUInt16BE(CP_FILE_NAME, off + 4);
    nameBytes.copy(buf, off + 6);

    return buf;
  }

  /**
   * Build a Create Directory request.
   *
   * @param {object} opts
   * @param {string} opts.dirName
   * @param {number} [opts.dirNameCCSID=13488]
   * @returns {Buffer}
   */
  static buildCreateDir(opts) {
    const { dirName, dirNameCCSID = UCS2_CCSID } = opts;
    const nameBytes = encodeName(dirName, dirNameCCSID);
    const templateLen = 8;
    const nameLLCP = 6 + nameBytes.length;
    const totalLen = 20 + templateLen + nameLLCP;

    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_CREATE_DIR, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_CREATE_DIR, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;             // chain indicator
    buf.writeUInt16BE(dirNameCCSID, off); off += 2;  // CCSID
    buf.writeUInt32BE(ROOT_HANDLE, off);             // working dir handle

    off = 20 + templateLen;
    buf.writeUInt32BE(nameLLCP, off);
    buf.writeUInt16BE(CP_DIR_NAME, off + 4);
    nameBytes.copy(buf, off + 6);

    return buf;
  }

  /**
   * Build a Delete Directory request.
   *
   * @param {object} opts
   * @param {string} opts.dirName
   * @param {number} [opts.dirNameCCSID=13488]
   * @returns {Buffer}
   */
  static buildDeleteDir(opts) {
    const { dirName, dirNameCCSID = UCS2_CCSID } = opts;
    const nameBytes = encodeName(dirName, dirNameCCSID);
    const templateLen = 10;
    const nameLLCP = 6 + nameBytes.length;
    const totalLen = 20 + templateLen + nameLLCP;

    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_DELETE_DIR, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_DELETE_DIR, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;             // chain indicator
    buf.writeUInt16BE(dirNameCCSID, off); off += 2;  // CCSID
    buf.writeUInt32BE(ROOT_HANDLE, off); off += 4;   // working dir handle
    buf.writeUInt16BE(0, off);                       // flags

    off = 20 + templateLen;
    buf.writeUInt32BE(nameLLCP, off);
    buf.writeUInt16BE(CP_DIR_NAME, off + 4);
    nameBytes.copy(buf, off + 6);

    return buf;
  }

  /**
   * Build a Rename request.
   *
   * @param {object} opts
   * @param {string} opts.sourceName
   * @param {string} opts.targetName
   * @param {number} [opts.ccsid=13488]
   * @param {boolean} [opts.replace=false] - Replace target if exists
   * @returns {Buffer}
   */
  static buildRename(opts) {
    const {
      sourceName,
      targetName,
      ccsid = UCS2_CCSID,
      replace = false,
    } = opts;

    const srcBytes = encodeName(sourceName, ccsid);
    const tgtBytes = encodeName(targetName, ccsid);
    const templateLen = 16;
    const srcLLCP = 6 + srcBytes.length;
    const tgtLLCP = 6 + tgtBytes.length;
    const totalLen = 20 + templateLen + srcLLCP + tgtLLCP;

    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_RENAME, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_RENAME, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;           // chain indicator
    buf.writeUInt16BE(ccsid, off); off += 2;       // source CCSID
    buf.writeUInt16BE(ccsid, off); off += 2;       // target CCSID
    buf.writeUInt32BE(ROOT_HANDLE, off); off += 4; // source working dir
    buf.writeUInt32BE(ROOT_HANDLE, off); off += 4; // target working dir
    buf.writeUInt16BE(replace ? 1 : 0, off);       // rename flags

    // Source name LL/CP
    off = 20 + templateLen;
    buf.writeUInt32BE(srcLLCP, off);
    buf.writeUInt16BE(CP_SOURCE_NAME, off + 4);
    srcBytes.copy(buf, off + 6);
    off += srcLLCP;

    // Target name LL/CP
    buf.writeUInt32BE(tgtLLCP, off);
    buf.writeUInt16BE(CP_TARGET_NAME, off + 4);
    tgtBytes.copy(buf, off + 6);

    return buf;
  }

  /**
   * Build a Copy File request.
   *
   * @param {object} opts
   * @param {string} opts.sourceName
   * @param {string} opts.targetName
   * @param {boolean} [opts.replace=false]
   * @returns {Buffer}
   */
  static buildCopy(opts) {
    const {
      sourceName,
      targetName,
      replace = false,
    } = opts;

    const ccsid = UCS2_CCSID;
    const srcBytes = encodeUCS2(sourceName);
    const tgtBytes = encodeUCS2(targetName);
    const templateLen = 16;
    const srcLLCP = 6 + srcBytes.length;
    const tgtLLCP = 6 + tgtBytes.length;
    const totalLen = 20 + templateLen + srcLLCP + tgtLLCP;

    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_COPY, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_COPY, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;           // chain indicator
    buf.writeUInt16BE(ccsid, off); off += 2;       // source CCSID
    buf.writeUInt16BE(ccsid, off); off += 2;       // target CCSID
    buf.writeUInt32BE(ROOT_HANDLE, off); off += 4; // source working dir
    buf.writeUInt32BE(ROOT_HANDLE, off); off += 4; // target working dir
    buf.writeUInt16BE(replace ? 0x01 : 0x08, off); // duplicate target option

    // Source name LL/CP
    off = 20 + templateLen;
    buf.writeUInt32BE(srcLLCP, off);
    buf.writeUInt16BE(CP_SOURCE_NAME, off + 4);
    srcBytes.copy(buf, off + 6);
    off += srcLLCP;

    // Target name LL/CP
    buf.writeUInt32BE(tgtLLCP, off);
    buf.writeUInt16BE(CP_TARGET_NAME, off + 4);
    tgtBytes.copy(buf, off + 6);

    return buf;
  }

  /**
   * Build a Change Attributes request.
   *
   * @param {object} opts
   * @param {string} opts.fileName
   * @param {number} [opts.fileNameCCSID=13488]
   * @param {number} [opts.fixedAttrs] - New file attributes (or undefined to skip)
   * @param {number} [opts.fileSize] - New file size (or undefined to skip)
   * @param {Date} [opts.modifyDate] - New modification date (or undefined)
   * @param {Date} [opts.accessDate] - New access date (or undefined)
   * @param {number} [opts.datastreamLevel=16]
   * @returns {Buffer}
   */
  static buildChangeAttrs(opts) {
    const {
      fileName,
      fileNameCCSID = UCS2_CCSID,
      fixedAttrs,
      fileSize,
      modifyDate,
      accessDate,
      datastreamLevel = 16,
    } = opts;

    const nameBytes = encodeName(fileName, fileNameCCSID);
    const useLarge = datastreamLevel >= 16;
    const templateLen = useLarge ? 56 : 48;
    const nameLLCP = 6 + nameBytes.length;
    const totalLen = 20 + templateLen + nameLLCP;

    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_CHANGE_ATTRS, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_CHANGE_ATTRS, 18);

    let setFlags = 0;

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;              // chain indicator
    buf.writeUInt32BE(0, off); off += 4;              // file handle (0 = use path)
    buf.writeUInt16BE(fileNameCCSID, off); off += 2;  // CCSID
    buf.writeUInt32BE(ROOT_HANDLE, off); off += 4;    // working dir handle
    buf.writeUInt16BE(OA_LEVEL1, off); off += 2;      // attr list level

    // Create date (8 bytes, skip)
    buf.fill(0, off, off + 8); off += 8;

    // Modify date (8 bytes)
    if (modifyDate instanceof Date) {
      IFSReq.#writeDateToBuffer(buf, off, modifyDate);
      setFlags |= 0x0002;
    }
    off += 8;

    // Access date (8 bytes)
    if (accessDate instanceof Date) {
      IFSReq.#writeDateToBuffer(buf, off, accessDate);
      setFlags |= 0x0004;
    }
    off += 8;

    // Set flags
    buf.writeUInt16BE(setFlags, off); off += 2;

    // Fixed attributes
    if (fixedAttrs !== undefined) {
      buf.writeUInt32BE(fixedAttrs, off);
    }
    off += 4;

    // File size (4-byte)
    if (!useLarge && fileSize !== undefined) {
      buf.writeUInt32BE(fileSize, off);
    }
    off += 4;

    if (useLarge && fileSize !== undefined) {
      buf.writeUInt32BE(Math.floor(fileSize / 0x100000000), off); off += 4;
      buf.writeUInt32BE(fileSize >>> 0, off);
    } else if (useLarge) {
      off += 8;
    }

    // File name LL/CP
    off = 20 + templateLen;
    buf.writeUInt32BE(nameLLCP, off);
    buf.writeUInt16BE(CP_FILE_NAME, off + 4);
    nameBytes.copy(buf, off + 6);

    return buf;
  }

  /**
   * Build a Lock Bytes request.
   *
   * @param {object} opts
   * @param {number} opts.fileHandle
   * @param {number} opts.offset - Lock start offset
   * @param {number} opts.length - Number of bytes to lock
   * @param {boolean} [opts.mandatory=true]
   * @param {boolean} [opts.shared=false] - true=shared, false=exclusive
   * @param {number} [opts.datastreamLevel=16]
   * @returns {Buffer}
   */
  static buildLockBytes(opts) {
    const {
      fileHandle,
      offset: lockOffset,
      length: lockLen,
      mandatory = true,
      shared = false,
      datastreamLevel = 16,
    } = opts;

    const useLarge = datastreamLevel >= 16;
    const lockDataLen = useLarge ? 26 : 14;
    const lockLLCP = 6 + lockDataLen;
    const templateLen = 10;
    const totalLen = 20 + templateLen + lockLLCP;

    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_LOCK_BYTES, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_LOCK_BYTES, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;              // chain indicator
    buf.writeUInt32BE(fileHandle, off); off += 4;     // file handle
    buf.writeUInt16BE(mandatory ? 0 : 1, off); off += 2; // lock flags
    buf.writeUInt16BE(0, off);                        // reserved

    // Lock list LL/CP
    off = 20 + templateLen;
    buf.writeUInt32BE(lockLLCP, off);
    buf.writeUInt16BE(0x0006, off + 4);               // code point
    let loff = off + 6;
    buf.writeUInt16BE(shared ? 1 : 0, loff); loff += 2; // lock type
    buf.writeUInt32BE(0, loff); loff += 4;            // base offset

    if (useLarge) {
      buf.writeUInt32BE(0, loff); loff += 4;          // pad
      buf.writeUInt32BE(Math.floor(lockOffset / 0x100000000), loff); loff += 4;
      buf.writeUInt32BE(lockOffset >>> 0, loff); loff += 4;
      buf.writeUInt32BE(Math.floor(lockLen / 0x100000000), loff); loff += 4;
      buf.writeUInt32BE(lockLen >>> 0, loff);
    } else {
      buf.writeUInt32BE(lockOffset, loff); loff += 4;
      buf.writeUInt32BE(lockLen, loff);
    }

    return buf;
  }

  /**
   * Build an Unlock Bytes request.
   *
   * @param {object} opts
   * @param {number} opts.fileHandle
   * @param {number} opts.offset
   * @param {number} opts.length
   * @param {number} [opts.datastreamLevel=16]
   * @returns {Buffer}
   */
  static buildUnlockBytes(opts) {
    const {
      fileHandle,
      offset: unlockOffset,
      length: unlockLen,
      datastreamLevel = 16,
    } = opts;

    const useLarge = datastreamLevel >= 16;
    const templateLen = useLarge ? 44 : 20;
    const totalLen = 20 + templateLen;
    const buf = Buffer.alloc(totalLen);
    const corr = DataStream.nextCorrelation();
    writeHeader(buf, totalLen, REQ_UNLOCK_BYTES, corr);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_UNLOCK_BYTES, 18);

    let off = 20;
    buf.writeUInt16BE(0, off); off += 2;              // chain indicator
    buf.writeUInt32BE(fileHandle, off); off += 4;     // file handle

    if (useLarge) {
      buf.writeUInt32BE(0, off); off += 4;            // base offset
      buf.writeUInt32BE(0, off); off += 4;            // relative offset (4-byte, 0 for large)
      buf.writeUInt32BE(0, off); off += 4;            // unlock length (4-byte, 0 for large)
      buf.writeUInt16BE(0, off); off += 2;            // flags
      // Large base offset
      buf.writeUInt32BE(0, off); off += 4;
      buf.writeUInt32BE(0, off); off += 4;
      // Large relative offset
      buf.writeUInt32BE(Math.floor(unlockOffset / 0x100000000), off); off += 4;
      buf.writeUInt32BE(unlockOffset >>> 0, off); off += 4;
      // Large unlock length
      buf.writeUInt32BE(Math.floor(unlockLen / 0x100000000), off); off += 4;
      buf.writeUInt32BE(unlockLen >>> 0, off);
    } else {
      buf.writeUInt32BE(0, off); off += 4;            // base offset
      buf.writeUInt32BE(unlockOffset, off); off += 4; // relative offset
      buf.writeUInt32BE(unlockLen, off); off += 4;    // unlock length
      buf.writeUInt16BE(0, off);                      // flags
    }

    return buf;
  }

  /**
   * Write a Date object as an 8-byte IBM timestamp.
   * Format: seconds since epoch (4 bytes) + microseconds (4 bytes).
   * @param {Buffer} buf
   * @param {number} off
   * @param {Date} date
   */
  static #writeDateToBuffer(buf, off, date) {
    const ms = date.getTime();
    const secs = Math.floor(ms / 1000);
    const micros = (ms % 1000) * 1000;
    buf.writeUInt32BE(secs, off);
    buf.writeUInt32BE(micros, off + 4);
  }
}
