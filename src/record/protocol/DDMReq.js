/**
 * DDM request builders.
 *
 * DDM (Distributed Data Management) uses its own framing distinct from
 * the Client Access datastream. A DDM request starts with a 6-byte
 * DSS header (length, flags, type, correlation), followed by one or more
 * DDM objects (code point + parameters).
 *
 * DSS Header (6 bytes):
 *   Offset  Length  Field
 *   0       2       Total DSS length (including header)
 *   2       1       Flags (0x00=continue, 0x01=end, 0x03=same-corr, 0x40=chained)
 *   3       1       Type (1=RQSDSS request, 2=RPYDSS reply, 3=OBJDSS object, 5=CMNDSS)
 *   4       2       Request correlation
 *
 * DDM Object (variable):
 *   Offset  Length  Field
 *   0       2       Length (including this header)
 *   2       2       Code point
 *   4       ...     Parameters
 *
 * Upstream: DDMRequestDataStream.java, DDMObjectDataStream.java,
 *           DDMSECCHKRequestDataStream.java, AS400FileImplRemote.java
 * @module record/protocol/DDMReq
 */

import { DataStream } from '../../transport/DataStream.js';
import { CharConverter } from '../../ccsid/CharConverter.js';

/** DDM architecture-level code points. */
export const CP = Object.freeze({
  // DDM commands
  EXCSAT:   0xD041,  // Exchange server attributes
  ACCSEC:   0xD44A,  // Access security
  SECCHK:   0xD017,  // Security check
  ACCRDB:   0xD004,  // Access relational database
  OPNQRY:   0xD012,  // Open query
  CLSQRY:   0xD048,  // Close query

  // Record-level DDM commands
  S38OPEN:  0xD011,  // Open file (S/38 style)
  S38CLOSE: 0xD013,  // Close file
  S38GET:   0xD005,  // Get record(s)
  S38GETD:  0xD046,  // Get record by RRN
  S38GETK:  0xD047,  // Get record by key
  S38GETM:  0xD049,  // Get multiple records
  S38PUT:   0xD006,  // Put (write) record
  S38UPD:   0xD007,  // Update record
  S38DEL:   0xD008,  // Delete record
  S38FEOD:  0xD02B,  // Force end of data
  S38PUTM:  0xD050,  // Put multiple records

  // DDM parameters
  RDBNAM:   0x2110,  // Relational database name
  SECMEC:   0x11A2,  // Security mechanism
  SECCHKCD: 0x11A4,  // Security check code
  USRID:    0x11A0,  // User ID
  PASSWORD: 0x11A1,  // Password
  SECTKN:   0x11DC,  // Security token
  SRVCLSNM: 0xD0A0,  // Server class name
  SRVNAM:   0x116D,  // Server name
  SRVRLSLV: 0x115A,  // Server release level
  EXTNAM:   0x115E,  // External name
  MGRLVLLS: 0x1404,  // Manager-level list
  EXCSAT_RD: 0x1443, // EXCSAT RD (reply data)
  SRVCLSNM_RD: 0xD0A0,

  // S/38 parameter code points
  S38CTLL:  0xD205,  // Control list (open options)
  S38BUF:   0xD405,  // Data buffer
  S38MSGID: 0xD104,  // Message ID
  S38MSGRM: 0xD402,  // Message return code
  S38IOFB:  0xD403,  // I/O feedback
  S38RRDS:  0xD407,  // Relative record descriptor set
  S38RLDS:  0xD406,  // Record lock descriptor set
  S38RECNB: 0xD404,  // Record number
  S38OPTL:  0xD408,  // Options list
  S38KEYD:  0xD409,  // Key descriptor
  S38NULLV: 0xD410,  // Null value indicators

  // DDM reply code points
  EXCSATRD: 0xD443,  // Exchange attributes reply
  ACCSECRD: 0xD47A,  // Access security reply
  SECCHKRM: 0xD017,  // Security check reply
  ACCRDBRM: 0xD004,  // Access RDB reply
  ENDQRYRM: 0xD01F,  // End of query

  // Error / diagnostic
  AGNPRMRM: 0xD040,  // Agent-permanent error
  SYNTAXRM: 0xD050,  // Syntax error
  PRCCNVRM: 0xD060,  // Process conversation error
  VALNSPRM: 0xD070,  // Value not supported
  CMDCHKRM: 0xD015,  // Command check
  CMDNSPRM: 0xD012,  // Command not supported
  RDBACCRM: 0xD018,  // RDB currently accessed
});

/** DDM DSS type constants. */
const DSS_REQUEST = 1;
const DSS_REPLY   = 2;
const DSS_OBJECT  = 3;

/** DSS flag bits. */
const DSS_CHAIN_END    = 0x01;
const DSS_SAME_CORREL  = 0x03;
const DSS_CHAINED      = 0x40;

/** Auto-incrementing correlation counter for DDM. */
let ddmCorrelation = 1;
function nextDDMCorrelation() {
  const id = ddmCorrelation;
  ddmCorrelation = ddmCorrelation >= 0x7FFF ? 1 : ddmCorrelation + 1;
  return id;
}

/**
 * Build a 6-byte DSS header.
 * @param {number} length - Total DSS length including header
 * @param {number} flags
 * @param {number} type
 * @param {number} correlation
 * @returns {Buffer}
 */
function buildDSSHeader(length, flags, type, correlation) {
  const buf = Buffer.alloc(6);
  buf.writeUInt16BE(length, 0);
  buf[2] = flags;
  buf[3] = type;
  buf.writeUInt16BE(correlation, 4);
  return buf;
}

/**
 * Build a DDM object with code point and optional parameters.
 * @param {number} codePoint
 * @param {Buffer[]} [params] - Parameter buffers
 * @returns {Buffer}
 */
function buildDDMObject(codePoint, params = []) {
  let paramsLen = 0;
  for (const p of params) paramsLen += p.length;
  const total = 4 + paramsLen;
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(total, 0);
  buf.writeUInt16BE(codePoint, 2);
  if (params.length === 0) return buf;
  return Buffer.concat([buf, ...params], total);
}

/**
 * Build a DDM parameter (LL/CP item).
 * @param {number} codePoint
 * @param {Buffer} data
 * @returns {Buffer}
 */
function buildParam(codePoint, data) {
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt16BE(4 + data.length, 0);
  buf.writeUInt16BE(codePoint, 2);
  data.copy(buf, 4);
  return buf;
}

/**
 * Build a DDM parameter with a 2-byte value.
 * @param {number} codePoint
 * @param {number} value
 * @returns {Buffer}
 */
function buildParam16(codePoint, value) {
  const data = Buffer.alloc(2);
  data.writeUInt16BE(value, 0);
  return buildParam(codePoint, data);
}

/**
 * Encode a string as EBCDIC bytes for DDM.
 * @param {string} str
 * @param {number} [padLen] - Pad to this length with EBCDIC spaces
 * @returns {Buffer}
 */
function encodeEBCDIC(str, padLen) {
  const conv = new CharConverter(37);
  const encoded = conv.stringToByteArray(str);
  if (padLen && encoded.length < padLen) {
    const buf = Buffer.alloc(padLen, 0x40);
    encoded.copy(buf, 0);
    return buf;
  }
  return encoded;
}

export class DDMReq {

  /**
   * Build an Exchange Server Attributes (EXCSAT) request.
   * @param {object} [opts]
   * @param {string} [opts.serverClassName='AS/400']
   * @param {string} [opts.serverName='js400']
   * @returns {Buffer}
   */
  static buildExchangeAttributes(opts = {}) {
    const srvclsnm = encodeEBCDIC(opts.serverClassName || 'AS/400');
    const srvnam = encodeEBCDIC(opts.serverName || 'js400');

    const mgrlvl = Buffer.alloc(16);
    // Agent = 3 (manager code point 0x1403, level 3)
    mgrlvl.writeUInt16BE(0x1403, 0);
    mgrlvl.writeUInt16BE(3, 2);
    // SECMGR = 1
    mgrlvl.writeUInt16BE(0x1440, 4);
    mgrlvl.writeUInt16BE(1, 6);
    // CMNTCPIP = 5
    mgrlvl.writeUInt16BE(0x1474, 8);
    mgrlvl.writeUInt16BE(5, 10);
    // RDB = 4
    mgrlvl.writeUInt16BE(0x240F, 12);
    mgrlvl.writeUInt16BE(4, 14);

    const params = [
      buildParam(CP.SRVCLSNM, srvclsnm),
      buildParam(CP.SRVNAM, srvnam),
      buildParam(CP.MGRLVLLS, mgrlvl),
    ];

    const obj = buildDDMObject(CP.EXCSAT, params);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build an Access Security (ACCSEC) request.
   * @param {object} opts
   * @param {number} opts.securityMechanism - Security mechanism code (3=user/pwd, 6=encrypted)
   * @param {string} opts.rdbName - Database name
   * @param {Buffer} [opts.securityToken] - Client seed for encrypted auth
   * @returns {Buffer}
   */
  static buildAccessSecurity(opts) {
    const params = [
      buildParam16(CP.SECMEC, opts.securityMechanism),
      buildParam(CP.RDBNAM, encodeEBCDIC(opts.rdbName, 18)),
    ];
    if (opts.securityToken) {
      params.push(buildParam(CP.SECTKN, opts.securityToken));
    }
    const obj = buildDDMObject(CP.ACCSEC, params);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build a Security Check (SECCHK) request.
   * @param {object} opts
   * @param {number} opts.securityMechanism
   * @param {string} opts.userId
   * @param {Buffer} opts.password - Encrypted or plain password bytes
   * @returns {Buffer}
   */
  static buildSecurityCheck(opts) {
    const params = [
      buildParam16(CP.SECMEC, opts.securityMechanism),
      buildParam(CP.USRID, encodeEBCDIC(opts.userId, 10)),
      buildParam(CP.PASSWORD, opts.password),
    ];
    const obj = buildDDMObject(CP.SECCHK, params);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build an S/38 Open File request.
   *
   * The control list (S38CTLL) encodes the open options:
   *   - file name, library, member
   *   - open type (input/output/update/all)
   *   - blocking factor
   *   - record format name
   *   - access type (sequential/keyed)
   *
   * @param {object} opts
   * @param {string} opts.fileName - Library-qualified file name (e.g. 'MYLIB/CUSTMAS')
   * @param {string} [opts.member='*FIRST'] - Member name
   * @param {string} [opts.openType='READ'] - 'READ', 'WRITE', 'READWRITE', 'ALL'
   * @param {number} [opts.blockingFactor=1] - Number of records per block
   * @param {string} [opts.recordFormatName=''] - Record format name
   * @param {boolean} [opts.keyed=false] - Whether to open for keyed access
   * @param {number} [opts.commitLock=0] - Commitment control lock level
   * @returns {Buffer}
   */
  static buildOpen(opts) {
    const {
      fileName,
      member = '*FIRST',
      openType = 'READ',
      blockingFactor = 1,
      recordFormatName = '',
      keyed = false,
      commitLock = 0,
    } = opts;

    // Parse library/file from fileName
    let library = '*LIBL';
    let file = fileName;
    const slashIdx = fileName.indexOf('/');
    if (slashIdx >= 0) {
      library = fileName.substring(0, slashIdx);
      file = fileName.substring(slashIdx + 1);
    }

    // S38 open control list:
    //   File name (10 bytes EBCDIC)
    //   Library (10 bytes EBCDIC)
    //   Member (10 bytes EBCDIC)
    //   Open flags (2 bytes)
    //   Blocking factor (2 bytes)
    //   Access type (2 bytes)
    //   Record format name (10 bytes EBCDIC)
    //   Commit lock level (2 bytes)
    //   Null-capable (1 byte)
    const ctll = Buffer.alloc(49, 0x40);  // pad with EBCDIC spaces
    encodeEBCDIC(file).copy(ctll, 0, 0, Math.min(10, encodeEBCDIC(file).length));
    encodeEBCDIC(library).copy(ctll, 10, 0, Math.min(10, encodeEBCDIC(library).length));
    encodeEBCDIC(member).copy(ctll, 20, 0, Math.min(10, encodeEBCDIC(member).length));

    // Open flags
    let openFlags = 0x0000;
    switch (openType.toUpperCase()) {
      case 'READ':      openFlags = 0x0001; break;
      case 'WRITE':     openFlags = 0x0002; break;
      case 'READWRITE': openFlags = 0x0003; break;
      case 'ALL':       openFlags = 0x000F; break;
      default:          openFlags = 0x0001; break;
    }
    ctll.writeUInt16BE(openFlags, 30);

    // Blocking factor
    ctll.writeUInt16BE(blockingFactor, 32);

    // Access type: 0 = sequential, 1 = keyed
    ctll.writeUInt16BE(keyed ? 1 : 0, 34);

    // Record format name
    if (recordFormatName) {
      const fmtBytes = encodeEBCDIC(recordFormatName);
      fmtBytes.copy(ctll, 36, 0, Math.min(10, fmtBytes.length));
    }

    // Commit lock level
    ctll.writeUInt16BE(commitLock, 46);

    // Null-capable flag
    ctll[48] = 0xF1;  // enable null support

    const params = [buildParam(CP.S38CTLL, ctll)];
    const obj = buildDDMObject(CP.S38OPEN, params);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build an S/38 Close File request.
   * @returns {Buffer}
   */
  static buildClose() {
    const obj = buildDDMObject(CP.S38CLOSE);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build an S/38 Get (sequential read) request.
   * @param {object} opts
   * @param {number} [opts.direction=1] - 1=next, 2=previous, 3=first, 4=last
   * @param {number} [opts.recordCount=1] - Number of records to return
   * @param {boolean} [opts.lockRecord=false] - Whether to lock the record
   * @returns {Buffer}
   */
  static buildGet(opts = {}) {
    const {
      direction = 1,
      recordCount = 1,
      lockRecord = false,
    } = opts;

    // Options list:
    //   direction (2 bytes)
    //   record count (2 bytes)
    //   lock (1 byte)
    const optl = Buffer.alloc(5);
    optl.writeUInt16BE(direction, 0);
    optl.writeUInt16BE(recordCount, 2);
    optl[4] = lockRecord ? 0xF1 : 0xF0;

    const params = [buildParam(CP.S38OPTL, optl)];
    const obj = buildDDMObject(CP.S38GET, params);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build an S/38 Get by RRN (relative record number) request.
   * @param {object} opts
   * @param {number} opts.recordNumber - Relative record number
   * @param {boolean} [opts.lockRecord=false]
   * @returns {Buffer}
   */
  static buildGetByRRN(opts) {
    const recNum = Buffer.alloc(4);
    recNum.writeUInt32BE(opts.recordNumber, 0);

    const optl = Buffer.alloc(1);
    optl[0] = opts.lockRecord ? 0xF1 : 0xF0;

    const params = [
      buildParam(CP.S38RECNB, recNum),
      buildParam(CP.S38OPTL, optl),
    ];
    const obj = buildDDMObject(CP.S38GETD, params);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build an S/38 Get by Key request.
   * @param {object} opts
   * @param {Buffer} opts.key - Key value as encoded buffer
   * @param {number} [opts.searchType=0] - 0=equal, 1=greater, 2=less, 3=ge, 4=le
   * @param {number} [opts.direction=0] - 0=none(exact), 1=next, 2=previous
   * @param {number} [opts.recordCount=1]
   * @param {boolean} [opts.lockRecord=false]
   * @returns {Buffer}
   */
  static buildGetByKey(opts) {
    const {
      key,
      searchType = 0,
      direction = 0,
      recordCount = 1,
      lockRecord = false,
    } = opts;

    // Key descriptor: search type (2), direction (2), record count (2), lock (1)
    const optl = Buffer.alloc(7);
    optl.writeUInt16BE(searchType, 0);
    optl.writeUInt16BE(direction, 2);
    optl.writeUInt16BE(recordCount, 4);
    optl[6] = lockRecord ? 0xF1 : 0xF0;

    const params = [
      buildParam(CP.S38KEYD, key),
      buildParam(CP.S38OPTL, optl),
    ];
    const obj = buildDDMObject(CP.S38GETK, params);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build an S/38 Put (write) record request.
   * @param {object} opts
   * @param {Buffer} opts.data - Record data buffer
   * @param {Buffer} [opts.nullMap] - Null field indicators
   * @returns {Buffer}
   */
  static buildPut(opts) {
    const params = [buildParam(CP.S38BUF, opts.data)];
    if (opts.nullMap) {
      params.push(buildParam(CP.S38NULLV, opts.nullMap));
    }
    const obj = buildDDMObject(CP.S38PUT, params);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build an S/38 Update record request.
   * Updates the currently positioned record.
   * @param {object} opts
   * @param {Buffer} opts.data - Updated record data buffer
   * @param {Buffer} [opts.nullMap] - Null field indicators
   * @returns {Buffer}
   */
  static buildUpdate(opts) {
    const params = [buildParam(CP.S38BUF, opts.data)];
    if (opts.nullMap) {
      params.push(buildParam(CP.S38NULLV, opts.nullMap));
    }
    const obj = buildDDMObject(CP.S38UPD, params);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build an S/38 Delete record request.
   * Deletes the currently positioned record.
   * @returns {Buffer}
   */
  static buildDelete() {
    const obj = buildDDMObject(CP.S38DEL);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Build an S/38 Force End of Data request.
   * Forces commit of output buffers.
   * @returns {Buffer}
   */
  static buildForceEndOfData() {
    const obj = buildDDMObject(CP.S38FEOD);
    const corr = nextDDMCorrelation();
    const hdr = buildDSSHeader(6 + obj.length, DSS_CHAIN_END, DSS_REQUEST, corr);
    return Buffer.concat([hdr, obj]);
  }

  /**
   * Reset DDM correlation counter (for testing).
   */
  static resetCorrelation() {
    ddmCorrelation = 1;
  }
}

// Export helpers for testing
DDMReq.buildDSSHeader = buildDSSHeader;
DDMReq.buildDDMObject = buildDDMObject;
DDMReq.buildParam = buildParam;
DDMReq.buildParam16 = buildParam16;
DDMReq.encodeEBCDIC = encodeEBCDIC;
DDMReq.CP = CP;
