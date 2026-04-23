/**
 * Database request datastream builders.
 *
 * Builds binary request buffers for the IBM i database host server.
 * Each static method returns a Buffer ready to send on the wire.
 *
 * Upstream: DBBaseRequestDS.java, DB*DS.java, jtopenlite/database/DatabaseConnection.java
 * @module db/protocol/DBRequestDS
 */

import { DataStream } from '../../transport/DataStream.js';
import {
  compressRLE,
  RLE_THRESHOLD,
  MIN_SAVINGS_BYTES,
  MIN_SAVINGS_PERCENT,
} from '../compression/rle.js';
import { CharConverter } from '../../ccsid/CharConverter.js';

/** Server ID for the database host server. */
const SERVER_ID = 0xE004;

/** RLE compression scheme code point (value for CP 0x3832). */
const DATA_COMPRESSION_RLE = 0x3832;

/** Standard database request template length (most operations). */
const TEMPLATE_LENGTH = 20;

/**
 * Request IDs for database server operations.
 * Values from JTOpen DBSQLRequestDS.java and jtopenlite DatabaseConnection.java.
 */
export const RequestID = Object.freeze({
  // SQL operations (0x18xx) — per DBSQLRequestDS.java
  PREPARE:                   0x1800,
  DESCRIBE:                  0x1801,
  DESCRIBE_PARAMETERS:       0x1802,
  PREPARE_AND_DESCRIBE:      0x1803,
  OPEN_AND_DESCRIBE:         0x1804,
  EXECUTE:                   0x1805,
  EXECUTE_IMMEDIATE:         0x1806,
  COMMIT:                    0x1807,
  ROLLBACK:                  0x1808,
  CLOSE_CURSOR:              0x180A,
  FETCH:                     0x180B,
  STREAM_FETCH:              0x180C,
  PREPARE_AND_EXECUTE:       0x180D,
  OPEN_DESCRIBE_FETCH:       0x180E,
  CREATE_PACKAGE:            0x180F,
  CLEAR_PACKAGE:             0x1810,
  DELETE_PACKAGE:            0x1811,
  EXECUTE_OR_OPEN_DESCRIBE:  0x1812,
  END_STREAM_FETCH:          0x1813,
  RETURN_PACKAGE:            0x1815,
  RETRIEVE_LOB_DATA:         0x1816,
  WRITE_LOB_DATA:            0x1817,
  CANCEL:                    0x1818,
  FREE_LOB:                  0x1819,

  // RPB management (0x1Dxx) — per jtopenlite sendCreateSQLRPBRequest
  CREATE_RPB:                0x1D00,
  DELETE_RPB:                0x1D02,
  RESET_RPB:                 0x1D04,

  // Descriptor management (0x1Exx) — per DBSQLDescriptorDS.java
  CHANGE_DESCRIPTOR:         0x1E00,
  DELETE_DESCRIPTOR:         0x1E01,

  // Server attributes (0x1Fxx)
  SET_SERVER_ATTRIBUTES:     0x1F80,
  RETRIEVE_SERVER_ATTRIBUTES: 0x1F81,
});

/**
 * Code points for database protocol LL/CP pairs (REQUEST side).
 * Values from JTOpen DBSQLRequestDS.java and jtopenlite DatabaseConnection.java.
 */
export const CodePoint = Object.freeze({
  // Request code points
  LIBRARY_NAME:                0x3801,
  PACKAGE_NAME:                0x3804,
  TRANSLATE_INDICATOR:         0x3805,
  PREPARED_STATEMENT_NAME:     0x3806,
  SQL_STATEMENT_TEXT:           0x3807,
  PREPARE_OPTION:              0x3808,
  OPEN_ATTRIBUTES:             0x3809,
  DESCRIBE_OPTION:             0x380A,
  CURSOR_NAME:                 0x380B,
  BLOCKING_FACTOR:             0x380C,
  SCROLLABLE_CURSOR_FLAG:      0x380D,
  FETCH_SCROLL_OPTION:         0x380E,
  HOLD_INDICATOR:              0x380F,
  REUSE_INDICATOR:             0x3810,
  PARAMETER_MARKER_DATA:       0x3811,
  STATEMENT_TYPE:              0x3812,
  PARAMETER_MARKER_BLOCK_IND:  0x3814,
  RETURN_SIZE:                 0x3815,
  LOB_LOCATOR_HANDLE:          0x3818,
  REQUESTED_SIZE:              0x3819,
  START_OFFSET:                0x381A,
  /**
   * JOB_IDENTIFIER (0x3826) — server job string used to target a
   * FUNCTIONID_CANCEL on the side-channel connection. JTOpen
   * `DBSQLRequestDS.setJobIdentifier`; server stores the 26-char
   * identifier in the job/user/id triple.
   */
  JOB_IDENTIFIER:              0x3826,
  EXTENDED_COLUMN_DESC_OPTION: 0x3829,
  EXTENDED_SQL_STATEMENT_TEXT: 0x3831,
  RLE_COMPRESSED_DATA:         0x3832,
  CLIENT_DATASTREAM_LEVEL:     0x3A01,
});

/**
 * Code points for database protocol REPLY side.
 * Some overlap with request CPs but have different meanings.
 */
export const ReplyCodePoint = Object.freeze({
  MESSAGE_ID:                  0x3801,
  FIRST_LEVEL_TEXT:            0x3802,
  SECOND_LEVEL_TEXT:           0x3803,
  SQLCA:                       0x3807,
  RESULT_DATA:                 0x380E,
  EXTENDED_COLUMN_DESCRIPTORS: 0x3811,
  SUPER_EXTENDED_DATA_FORMAT:  0x3812,
  RLE_COMPRESSED_DATA:         0x3832,
});

/** Prepare option values. */
export const PrepareOption = Object.freeze({
  NORMAL:           0,
  ENHANCED:         1,
});

/** Open attribute bit flags. */
export const OpenAttributes = Object.freeze({
  READ_ONLY:        0x80,
  WRITE_ONLY:       0x40,
  READ_WRITE:       0xC0,
  ALL:              0xF0,
});

/** Describe option values. */
export const DescribeOption = Object.freeze({
  NONE:     0,
  COLUMNS:  1,
  BOTH:     2,
  PARAMS:   3,
});

/** SQL statement type values (for STATEMENT_TYPE code point 0x3812). */
export const StatementType = Object.freeze({
  OTHER:    0,
  SELECT:   4,
  CALL:     3,
  COMMIT:   5,
  ROLLBACK: 6,
  CONNECT:  7,
  BLOCK_INSERT: 8,
});

/** Fetch scroll orientation. */
export const FetchScroll = Object.freeze({
  NEXT:      0,
  PREVIOUS:  1,
  FIRST:     2,
  LAST:      3,
  BEFORE:    4,
  AFTER:     5,
  CURRENT:   6,
  RELATIVE:  7,
  ABSOLUTE:  8,
});

/**
 * Operational Result Set (ORS) bitmap flags.
 * These tell the server what data to return in the reply.
 * Values from jtopenlite OperationalResultBitmap.java.
 */
export const ORSBitmap = Object.freeze({
  SEND_REPLY_IMMED:              0x80000000,
  MESSAGE_ID:                    0x40000000,
  FIRST_LEVEL_TEXT:              0x20000000,
  SECOND_LEVEL_TEXT:             0x10000000,
  DATA_FORMAT:                   0x08000000,
  RESULT_DATA:                   0x04000000,
  SQLCA:                         0x02000000,
  SERVER_ATTRIBUTES:             0x01000000,
  PARAMETER_MARKER_FORMAT:       0x00800000,
  TRANSLATION_TABLES:            0x00400000,
  DATA_SOURCE_INFORMATION:       0x00200000,
  PACKAGE_INFORMATION:           0x00100000,
  REQUEST_RLE_COMPRESSED:        0x00080000,
  REPLY_RLE_COMPRESSED:          0x00040000,
  EXTENDED_COLUMN_DESCRIPTORS:   0x00020000,
  REPLY_VARLEN_COLUMN_COMPRESSED: 0x00010000,
  RETURN_RESULT_SET_ATTRIBUTES:  0x00008000,
});

/** Default ORS bitmap: just request a reply. */
const DEFAULT_ORS_BITMAP = ORSBitmap.SEND_REPLY_IMMED;

/** Unicode CCSID for text code points. */
const UNICODE_CCSID = 13488;

/**
 * Encode a JS string as UTF-16BE for the database server wire protocol.
 * @param {string} str
 * @returns {Buffer}
 */
function encodeUtf16BE(str) {
  const buf = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  }
  return buf;
}

/**
 * Build a text code point (LL/CP with CCSID + length prefix).
 * Layout: LL(4) + CP(2) + CCSID(2) + textLength(2) + encoded text.
 *
 * For SQL statement text js400 still defaults to Unicode (CCSID 13488),
 * matching the existing working path. For identifier-like code points
 * (cursor name, statement name, library/package name) callers can pass
 * the server/job CCSID so the host stores the name exactly the same way
 * JTOpen does through its connection converter.
 *
 * Per JTOpen DBBaseRequestDS.addParameter(int, ConvTable, String).
 * @param {number} cp - code point
 * @param {string} text
 * @param {number} [ccsid=13488]
 * @returns {Buffer}
 */
function buildTextCP(cp, text, ccsid = UNICODE_CCSID) {
  const textBuf = ccsid === UNICODE_CCSID
    ? encodeUtf16BE(text)
    : CharConverter.stringToByteArray(text, ccsid);
  const ll = 10 + textBuf.length;
  const buf = Buffer.alloc(ll);
  buf.writeInt32BE(ll, 0);
  buf.writeUInt16BE(cp, 4);
  buf.writeUInt16BE(ccsid, 6);
  buf.writeUInt16BE(textBuf.length, 8);
  textBuf.copy(buf, 10);
  return buf;
}

/**
 * Build an extended text code point (4-byte length prefix).
 * Layout: LL(4) + CP(2) + CCSID(2) + textLength(4) + UTF-16BE text
 * Per jtopenlite writeExtendedSQLStatementText.
 * Used for SQL statement text which may exceed 65535 bytes.
 * @param {number} cp - code point
 * @param {string} text
 * @returns {Buffer}
 */
function buildExtTextCP(cp, text) {
  const textBuf = encodeUtf16BE(text);
  const ll = 12 + textBuf.length;
  const buf = Buffer.alloc(ll);
  buf.writeInt32BE(ll, 0);
  buf.writeUInt16BE(cp, 4);
  buf.writeUInt16BE(UNICODE_CCSID, 6);
  buf.writeInt32BE(textBuf.length, 8);
  textBuf.copy(buf, 12);
  return buf;
}

/**
 * Build a 2-byte value code point.
 * Layout: LL(4) + CP(2) + value(2)
 */
function buildShortCP(cp, value) {
  const buf = Buffer.alloc(8);
  buf.writeInt32BE(8, 0);
  buf.writeUInt16BE(cp, 4);
  buf.writeInt16BE(value, 6);
  return buf;
}

/**
 * Build a 4-byte value code point.
 * Layout: LL(4) + CP(2) + value(4)
 */
function buildIntCP(cp, value) {
  const buf = Buffer.alloc(10);
  buf.writeInt32BE(10, 0);
  buf.writeUInt16BE(cp, 4);
  buf.writeInt32BE(value, 6);
  return buf;
}

/**
 * Build a 1-byte value code point.
 * Layout: LL(4) + CP(2) + value(1)
 */
function buildByteCP(cp, value) {
  const buf = Buffer.alloc(7);
  buf.writeInt32BE(7, 0);
  buf.writeUInt16BE(cp, 4);
  buf[6] = value & 0xFF;
  return buf;
}

/**
 * Build a raw data code point.
 * Layout: LL(4) + CP(2) + data
 */
function buildRawCP(cp, data) {
  const ll = 6 + data.length;
  const buf = Buffer.alloc(ll);
  buf.writeInt32BE(ll, 0);
  buf.writeUInt16BE(cp, 4);
  data.copy(buf, 6);
  return buf;
}

/**
 * Build an empty code point (length-only, no value). JTOpen uses this
 * shape when a property is "present but unset" — e.g. `setPackageName(null)`
 * which tells the server to drop the current RPB's package binding for
 * a single prepare even though the connection itself is package-bound.
 */
function buildEmptyCP(cp) {
  const buf = Buffer.alloc(6);
  buf.writeInt32BE(6, 0);
  buf.writeUInt16BE(cp, 4);
  return buf;
}

/**
 * Write the standard 20-byte database request template.
 *
 * Layout (per JTOpen DBBaseRequestDS.java & jtopenlite DatabaseConnection):
 *   +0:  int32  ORS bitmap (operation result bitmap)
 *   +4:  int32  Reserved
 *   +8:  int16  Return ORS handle (typically = rpbId)
 *   +10: int16  Fill ORS handle (typically = rpbId)
 *   +12: int16  Based-on ORS handle
 *   +14: int16  RPB handle (typically = rpbId)
 *   +16: int16  Parameter marker descriptor handle
 *   +18: int16  Parameter count
 *
 * @param {Buffer} buf - target buffer
 * @param {number} offset - offset within buf where template starts
 * @param {object} opts
 */
function writeTemplate(buf, offset, opts = {}) {
  const orsBitmap = (opts.orsBitmap ?? DEFAULT_ORS_BITMAP) >>> 0;
  const rpbId = opts.rpbId ?? 0;
  buf.writeUInt32BE(orsBitmap, offset);                                // +0: ORS bitmap
  buf.writeInt32BE(0, offset + 4);                                     // +4: Reserved
  buf.writeInt16BE(rpbId, offset + 8);                                 // +8: Return ORS handle
  buf.writeInt16BE(rpbId, offset + 10);                                // +10: Fill ORS handle
  buf.writeInt16BE(0, offset + 12);                                    // +12: Based-on ORS handle
  buf.writeInt16BE(rpbId, offset + 14);                                // +14: RPB handle
  buf.writeInt16BE(opts.pmDescriptorHandle ?? 0, offset + 16);         // +16: PM descriptor handle
  buf.writeInt16BE(opts.paramCount ?? 0, offset + 18);                 // +18: Parameter count
}

/**
 * Assemble a complete database request packet.
 * @param {number} reqRepId
 * @param {number} templateLen
 * @param {Buffer} template - pre-built template bytes
 * @param {Buffer[]} codePoints - array of pre-built LL/CP buffers
 * @param {number} [correlation] - optional correlation ID
 * @returns {Buffer}
 */
function assemblePacket(reqRepId, templateLen, template, codePoints, correlation) {
  let cpLen = 0;
  for (const cp of codePoints) cpLen += cp.length;

  const totalLen = DataStream.HEADER_LENGTH + templateLen + cpLen;
  const buf = Buffer.alloc(totalLen);

  // Write header
  buf.writeInt32BE(totalLen, 0);
  buf.writeInt16BE(0, 4);              // header ID
  buf.writeUInt16BE(SERVER_ID, 6);     // server ID
  buf.writeInt32BE(0, 8);              // CS instance
  const corr = correlation ?? DataStream.nextCorrelation();
  buf.writeInt32BE(corr, 12);          // correlation
  buf.writeInt16BE(templateLen, 16);   // template length
  buf.writeUInt16BE(reqRepId, 18);     // request/reply ID

  // Write template
  template.copy(buf, DataStream.HEADER_LENGTH);

  // Write code points
  let offset = DataStream.HEADER_LENGTH + templateLen;
  for (const cp of codePoints) {
    cp.copy(buf, offset);
    offset += cp.length;
  }

  return buf;
}

export class DBRequestDS {

  /**
   * Build exchange server attributes request.
   * @param {object} opts
   * @param {number} [opts.clientAttributes=0] - client capability flags
   * @param {number} [opts.ccsid=13488] - client CCSID
   * @param {number} [opts.nlv=0] - National Language Version
   * @param {number} [opts.datastreamLevel=5] - client datastream level
   * @returns {Buffer}
   */
  static buildExchangeAttributes(opts = {}) {
    const ccsid = opts.ccsid ?? UNICODE_CCSID;
    const dsLevel = opts.datastreamLevel ?? 5;

    // Code points for attributes to set (per jtopenlite JDBCConnection.setServerAttributes)
    const cps = [
      buildShortCP(0x3801, ccsid),                          // Default Client CCSID
      buildShortCP(CodePoint.BLOCKING_FACTOR, opts.namingConvention ?? 0), // Naming Convention (0=SQL, 1=System)
      buildByteCP(CodePoint.TRANSLATE_INDICATOR, opts.translateIndicator ?? 1), // Translate Indicator
      buildShortCP(CodePoint.SQL_STATEMENT_TEXT, opts.dateFormat ?? 5), // Date Format (5=ISO)
      buildIntCP(CodePoint.CLIENT_DATASTREAM_LEVEL, dsLevel), // Client Datastream Level
    ];

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.SERVER_ATTRIBUTES,
      paramCount: cps.length,
    });

    return assemblePacket(
      RequestID.SET_SERVER_ATTRIBUTES,
      TEMPLATE_LENGTH,
      template,
      cps,
    );
  }

  /**
   * Build create request parameter block (RPB) request.
   * Establishes a server-side parameter block for statement execution context.
   * @param {object} opts
   * @param {number} opts.rpbId - RPB identifier
   * @param {string} [opts.libraryName] - default library/schema
   * @param {string} [opts.packageName] - SQL package name
   * @param {number} [opts.translateIndicator] - translation mode
   * @param {number} [opts.prepareOption] - prepare behavior
   * @param {number} [opts.openAttributes] - cursor open mode
   * @param {number} [opts.describeOption] - describe behavior
   * @param {number} [opts.scrollable] - scrollable cursor flag
   * @param {number} [opts.holdIndicator] - cursor hold across commit
   * @param {number} [opts.blockingFactor] - rows per fetch block
   * @returns {Buffer}
   */
  static buildCreateRPB(opts) {
    const cps = [];
    const identifierCcsid = opts.identifierCcsid ?? UNICODE_CCSID;

    if (opts.cursorName) cps.push(buildTextCP(CodePoint.CURSOR_NAME, opts.cursorName, identifierCcsid));
    if (opts.statementName) cps.push(buildTextCP(CodePoint.PREPARED_STATEMENT_NAME, opts.statementName, identifierCcsid));
    if (opts.libraryName) cps.push(buildTextCP(CodePoint.LIBRARY_NAME, opts.libraryName, identifierCcsid));
    if (opts.packageName) cps.push(buildTextCP(CodePoint.PACKAGE_NAME, opts.packageName, identifierCcsid));
    if (opts.translateIndicator != null) cps.push(buildByteCP(CodePoint.TRANSLATE_INDICATOR, opts.translateIndicator));
    if (opts.prepareOption != null) cps.push(buildByteCP(CodePoint.PREPARE_OPTION, opts.prepareOption));
    if (opts.openAttributes != null) cps.push(buildByteCP(CodePoint.OPEN_ATTRIBUTES, opts.openAttributes));
    if (opts.describeOption != null) cps.push(buildByteCP(CodePoint.DESCRIBE_OPTION, opts.describeOption));
    if (opts.scrollable != null) cps.push(buildShortCP(CodePoint.SCROLLABLE_CURSOR_FLAG, opts.scrollable));
    if (opts.holdIndicator != null) cps.push(buildByteCP(CodePoint.HOLD_INDICATOR, opts.holdIndicator));
    if (opts.blockingFactor != null) cps.push(buildIntCP(CodePoint.BLOCKING_FACTOR, opts.blockingFactor));

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED,
      rpbId: opts.rpbId,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.CREATE_RPB, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build delete RPB request.
   * @param {object} opts
   * @param {number} opts.rpbId
   * @returns {Buffer}
   */
  static buildDeleteRPB(opts) {
    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED,
      rpbId: opts.rpbId,
    });
    return assemblePacket(RequestID.DELETE_RPB, TEMPLATE_LENGTH, template, []);
  }

  /**
   * Build a CANCEL (0x1818) request.
   *
   * Sent on a dedicated side-channel database connection so a cancel
   * request doesn't deadlock behind an in-flight execute on the
   * primary connection. Mirrors JTOpen `AS400JDBCConnectionImpl.cancel`:
   * the template's RPB handle is the CONNECTION id (`id_` in JTOpen)
   * of the *target* connection whose statement should be interrupted,
   * and the code points carry the server job identifier (JTOpen
   * `DBSQLRequestDS.setJobIdentifier`, code point 0x3826) so the
   * server can route the cancel to the correct job.
   *
   * Callers must pass `jobIdentifier` (the 26-char server job string
   * captured from the exchange-attributes reply). Without it the
   * cancel is an all-connections operation which js400 explicitly
   * refuses; the caller should fall back to post-RTT HY008 instead.
   *
   * @param {object} opts
   * @param {number} opts.rpbId — connection-scoped RPB handle for the
   *   target connection (NOT the target statement's RPB).
   * @param {string} opts.jobIdentifier — 26-char job/user/id string.
   * @param {number} [opts.identifierCcsid=13488]
   * @returns {Buffer}
   */
  static buildCancel(opts) {
    if (typeof opts.jobIdentifier !== 'string' || opts.jobIdentifier.length === 0) {
      throw new Error('buildCancel requires a jobIdentifier');
    }
    const identifierCcsid = opts.identifierCcsid ?? UNICODE_CCSID;
    const cps = [
      buildTextCP(CodePoint.JOB_IDENTIFIER, opts.jobIdentifier, identifierCcsid),
    ];

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      // `SEND_REPLY_IMMED` alone mirrors JTOpen's
      // ORS_BITMAP_RETURN_DATA for cancel — no SQLCA is needed, the
      // server returns only the reply template.
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED,
      rpbId: opts.rpbId ?? 0,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.CANCEL, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build a CREATE PACKAGE (0x180F) request.
   *
   * Used when `extendedDynamic` is on to materialize a server-side
   * SQL package into which subsequent PREPARE requests will deposit
   * their access plans. Mirrors JTOpen `JDPackageManager.create`:
   * sends `PACKAGE_NAME` (0x3804) + `LIBRARY_NAME` (0x3801), asks for
   * SQLCA back, and lets the caller interpret SQLCODE -601 ("already
   * exists") as a success case.
   *
   * @param {object} opts
   * @param {number} opts.rpbId — RPB to tie the request to
   * @param {string} opts.packageName — normalized 10-char name
   * @param {string} opts.packageLibrary — uppercased library; JTOpen
   *   defaults to `QGPL`
   * @param {number} [opts.identifierCcsid=13488]
   * @returns {Buffer}
   */
  static buildCreatePackage(opts) {
    const identifierCcsid = opts.identifierCcsid ?? UNICODE_CCSID;
    const cps = [
      buildTextCP(CodePoint.PACKAGE_NAME, opts.packageName, identifierCcsid),
      buildTextCP(CodePoint.LIBRARY_NAME, opts.packageLibrary, identifierCcsid),
    ];

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.SQLCA,
      rpbId: opts.rpbId ?? 0,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.CREATE_PACKAGE, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build a RETURN PACKAGE (0x1815) request.
   *
   * Pulls down the current contents of a server-side SQL package so
   * the client can reuse packaged statement names at prepare time.
   * Mirrors JTOpen `JDPackageManager.cache`: PACKAGE_NAME +
   * LIBRARY_NAME + RETURN_SIZE (0x3815) of 0, with
   * `ORSBitmap.PACKAGE_INFORMATION` added to the ORS so the reply
   * contains the package blob.
   *
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {string} opts.packageName
   * @param {string} opts.packageLibrary
   * @param {number} [opts.returnSize=0]
   * @param {number} [opts.identifierCcsid=13488]
   * @returns {Buffer}
   */
  static buildReturnPackage(opts) {
    const identifierCcsid = opts.identifierCcsid ?? UNICODE_CCSID;
    const cps = [
      buildTextCP(CodePoint.PACKAGE_NAME, opts.packageName, identifierCcsid),
      buildTextCP(CodePoint.LIBRARY_NAME, opts.packageLibrary, identifierCcsid),
      buildIntCP(CodePoint.RETURN_SIZE, opts.returnSize ?? 0),
    ];

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED
        | ORSBitmap.SQLCA
        | ORSBitmap.PACKAGE_INFORMATION,
      rpbId: opts.rpbId ?? 0,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.RETURN_PACKAGE, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build prepare statement request.
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {string} opts.sqlText - SQL statement to prepare
   * @param {string} [opts.statementName] - prepared statement name (required by server)
   * @param {number} [opts.prepareOption=0]
   * @param {number} [opts.translateIndicator]
   * @returns {Buffer}
   */
  static buildPrepare(opts) {
    const cps = [];
    if (opts.statementName) {
      cps.push(buildTextCP(
        CodePoint.PREPARED_STATEMENT_NAME,
        opts.statementName,
        opts.identifierCcsid ?? UNICODE_CCSID,
      ));
    }
    cps.push(buildExtTextCP(CodePoint.EXTENDED_SQL_STATEMENT_TEXT, opts.sqlText));
    if (opts.prepareOption != null) cps.push(buildByteCP(CodePoint.PREPARE_OPTION, opts.prepareOption));
    if (opts.translateIndicator != null) cps.push(buildByteCP(CodePoint.TRANSLATE_INDICATOR, opts.translateIndicator));

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED,
      rpbId: opts.rpbId,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.PREPARE, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build prepare-and-describe request (prepare + get column/param metadata).
   * Per jtopenlite: uses extended SQL text (0x3831), includes statement type,
   * prepare option, open attributes, and extended column descriptor option.
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {string} opts.sqlText
   * @param {string} [opts.statementName] - prepared statement name (required by server)
   * @param {number} [opts.statementType] - SQL statement type (StatementType enum)
   * @param {number} [opts.prepareOption=0] - prepare behavior
   * @param {number} [opts.openAttributes] - cursor open mode (0x80=read-only)
   * @param {number} [opts.extendedColumnDescriptorOption] - column desc format (0xF1)
   * @param {number} [opts.describeOption] - describe behavior
   * @param {number} [opts.pmDescriptorHandle=0]
   * @param {number} [opts.translateIndicator]
   * @returns {Buffer}
   */
  static buildPrepareAndDescribe(opts) {
    const cps = [];
    const identifierCcsid = opts.identifierCcsid ?? UNICODE_CCSID;
    if (opts.statementName) {
      cps.push(buildTextCP(
        CodePoint.PREPARED_STATEMENT_NAME,
        opts.statementName,
        identifierCcsid,
      ));
    }
    cps.push(buildExtTextCP(CodePoint.EXTENDED_SQL_STATEMENT_TEXT, opts.sqlText));
    if (opts.statementType != null) cps.push(buildShortCP(CodePoint.STATEMENT_TYPE, opts.statementType));
    if (opts.prepareOption != null) cps.push(buildByteCP(CodePoint.PREPARE_OPTION, opts.prepareOption));
    if (opts.openAttributes != null) cps.push(buildByteCP(CodePoint.OPEN_ATTRIBUTES, opts.openAttributes));
    if (opts.describeOption != null) cps.push(buildByteCP(CodePoint.DESCRIBE_OPTION, opts.describeOption));
    if (opts.extendedColumnDescriptorOption != null) cps.push(buildByteCP(CodePoint.EXTENDED_COLUMN_DESC_OPTION, opts.extendedColumnDescriptorOption));
    // Extended-dynamic package binding: when a caller asks us to store
    // this statement in a server-side SQL package, attach PACKAGE_NAME
    // to the PREPARE request. The library is already bound on
    // CREATE_RPB, so PREPARE only repeats the package name. A null
    // packageName sends the "empty" CP, which is how JTOpen tells the
    // server "this specific statement is not eligible for the package"
    // even though the RPB's library is still bound.
    if (opts.packageName === null) {
      cps.push(buildEmptyCP(CodePoint.PACKAGE_NAME));
    } else if (typeof opts.packageName === 'string' && opts.packageName.length > 0) {
      cps.push(buildTextCP(CodePoint.PACKAGE_NAME, opts.packageName, identifierCcsid));
    }
    if (opts.translateIndicator != null) cps.push(buildByteCP(CodePoint.TRANSLATE_INDICATOR, opts.translateIndicator));

    let orsBitmap = ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.DATA_FORMAT;
    if (opts.extendedColumnDescriptorOption != null) orsBitmap |= ORSBitmap.EXTENDED_COLUMN_DESCRIPTORS;
    if (opts.parameterMarkerFormat === true) orsBitmap |= ORSBitmap.PARAMETER_MARKER_FORMAT;

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap,
      rpbId: opts.rpbId,
      paramCount: cps.length,
      pmDescriptorHandle: opts.pmDescriptorHandle ?? 0,
    });

    return assemblePacket(RequestID.PREPARE_AND_DESCRIBE, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build an EXECUTE request with the parameter marker data region
   * reserved (but uninitialized) in the final packet buffer. Returns
   * both the packet buffer and the byte offset where the caller must
   * write `parameterMarkerDataSize` bytes of DBOriginalData content.
   *
   * This avoids two memcopies (buildRawCP's alloc+copy of the parameter
   * buffer, then assemblePacket's alloc+copy into the final packet)
   * that dominate CPU time for large batched INSERTs. For a 4K-row
   * batch the parameterMarkerData is ~2-3MB; both copies are pure CPU
   * waste.
   *
   * Packet layout:
   *   +0  : header (20 bytes)        totalLen, headerId=0, serverId=0xE004,
   *                                  CS=0, correlation, templateLen=20,
   *                                  reqId=0x1805 (EXECUTE)
   *   +20 : template (20 bytes)      ORS bitmap | SQLCA, handles,
   *                                  paramCount=2, pmDescriptorHandle
   *   +40 : BLOCK_IND CP (8 bytes)   LL=8, CP=0x3814, statementType(int16)
   *   +48 : PM_DATA CP header (6)    LL=6+paramDataSize, CP=0x3811
   *   +54 : <caller writes DBOriginalData content here, paramDataSize bytes>
   *
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {number} [opts.pmDescriptorHandle=0]
   * @param {number} [opts.statementType=0]
   * @param {number} opts.parameterMarkerDataSize - bytes caller will write
   * @param {boolean} [opts.rleRequestCompression=false] - mark packet as RLE-compressible
   * @param {boolean} [opts.rleReplyCompression=false] - ask the server to RLE-compress its reply
   * @returns {{ buffer: Buffer, paramDataOffset: number }}
   */
  static buildExecuteInPlace(opts) {
    const paramDataSize = opts.parameterMarkerDataSize | 0;
    if (paramDataSize <= 0) {
      throw new Error('parameterMarkerDataSize must be > 0');
    }

    const headerLen = DataStream.HEADER_LENGTH;  // 20
    const templateLen = TEMPLATE_LENGTH;          // 20
    const blockIndCpLen = 8;
    const pmCpHeaderLen = 6;
    const pmCpLen = pmCpHeaderLen + paramDataSize;
    const totalLen = headerLen + templateLen + blockIndCpLen + pmCpLen;

    // allocUnsafe is safe: every byte through paramDataOffset is written
    // below; the caller is contractually required to fill
    // paramDataSize bytes starting at paramDataOffset.
    const buf = Buffer.allocUnsafe(totalLen);

    // ---- Packet header (20 bytes) ----
    buf.writeInt32BE(totalLen, 0);
    buf.writeInt16BE(0, 4);                        // header ID
    buf.writeUInt16BE(SERVER_ID, 6);               // server ID
    buf.writeInt32BE(0, 8);                        // CS instance
    buf.writeInt32BE(DataStream.nextCorrelation(), 12);
    buf.writeInt16BE(templateLen, 16);             // template length
    buf.writeUInt16BE(RequestID.EXECUTE, 18);      // request ID

    // ---- Template (20 bytes) ----
    const tOff = headerLen;
    let orsBitmap = (ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.SQLCA) >>> 0;
    if (opts.rleRequestCompression) orsBitmap = (orsBitmap | ORSBitmap.REQUEST_RLE_COMPRESSED) >>> 0;
    if (opts.rleReplyCompression) orsBitmap = (orsBitmap | ORSBitmap.REPLY_RLE_COMPRESSED) >>> 0;
    const rpbId = opts.rpbId ?? 0;
    buf.writeUInt32BE(orsBitmap, tOff);            // ORS bitmap
    buf.writeInt32BE(0, tOff + 4);                 // reserved
    buf.writeInt16BE(rpbId, tOff + 8);             // Return ORS handle
    buf.writeInt16BE(rpbId, tOff + 10);            // Fill ORS handle
    buf.writeInt16BE(0, tOff + 12);                // Based-on ORS handle
    buf.writeInt16BE(rpbId, tOff + 14);            // RPB handle
    buf.writeInt16BE(opts.pmDescriptorHandle ?? 0, tOff + 16); // PM desc handle
    buf.writeInt16BE(2, tOff + 18);                // paramCount = 2 CPs

    // ---- BLOCK_IND CP (8 bytes) ----
    let cpOff = headerLen + templateLen;
    buf.writeInt32BE(blockIndCpLen, cpOff);
    buf.writeUInt16BE(CodePoint.PARAMETER_MARKER_BLOCK_IND, cpOff + 4);
    buf.writeInt16BE(opts.statementType ?? 0, cpOff + 6);
    cpOff += blockIndCpLen;

    // ---- PARAMETER_MARKER_DATA CP header (6 bytes) ----
    buf.writeInt32BE(pmCpLen, cpOff);
    buf.writeUInt16BE(CodePoint.PARAMETER_MARKER_DATA, cpOff + 4);
    const paramDataOffset = cpOff + pmCpHeaderLen;

    return { buffer: buf, paramDataOffset };
  }

  /**
   * Try to RLE-compress an already-built request packet in place of
   * its original uncompressed form.
   *
   * Reads the current packet's header (20 bytes) + template (20 bytes),
   * compresses the tail (bytes 40..end), and if the compression saves
   * at least {@link MIN_SAVINGS_PERCENT}% AND {@link MIN_SAVINGS_BYTES}
   * bytes, returns a freshly-allocated buffer in the RLE-wrapped wire
   * format:
   *
   *   bytes 0-3   LL   = compressed total length
   *   bytes 4-19  header (copied from original bytes 4..19)
   *   bytes 20-39 template (copied from original bytes 20..39, with
   *                REQUEST_RLE_COMPRESSED bit still set)
   *   bytes 40-43 ll   = compressed data length + 10
   *   bytes 44-45 CP   = 0x3832 (DATA_COMPRESSION_RLE)
   *   bytes 46-49      = decompressed length of bytes 40..origEnd
   *   bytes 50+        = compressed data
   *
   * If the packet is below the {@link RLE_THRESHOLD} or compression
   * does not pay off, the ORS bitmap's REQUEST_RLE_COMPRESSED bit is
   * CLEARED in the original buffer (per JTOpen's behaviour), and that
   * buffer is returned as-is.
   *
   * The REPLY_RLE_COMPRESSED bit is never cleared — the server may
   * still compress its reply regardless.
   *
   * @param {Buffer} reqBuf - a complete, uncompressed request packet
   *   whose template has REQUEST_RLE_COMPRESSED already set
   * @returns {Buffer} either the original buffer (uncompressed) or a
   *   new RLE-wrapped buffer
   */
  static compressRequestInPlace(reqBuf) {
    const total = reqBuf.length;
    const headerLen = DataStream.HEADER_LENGTH;
    const templateLen = TEMPLATE_LENGTH;
    const headerTemplateLen = headerLen + templateLen;  // 40

    // Too small to bother.
    if (total <= RLE_THRESHOLD) {
      // Clear the REQUEST_RLE bit — nothing is actually compressed.
      const bits = reqBuf.readUInt32BE(headerLen);
      reqBuf.writeUInt32BE((bits & ~ORSBitmap.REQUEST_RLE_COMPRESSED) >>> 0, headerLen);
      return reqBuf;
    }

    const dataLen = total - headerTemplateLen;

    // Allocate scratch for the worst-case compressed packet: wrapper
    // (50 bytes) + dataLen. If compression doesn't help we just
    // return the original.
    const scratch = Buffer.allocUnsafe(50 + dataLen);
    const compressedSize = compressRLE(reqBuf, headerTemplateLen, dataLen, scratch, 50);

    let useCompression = compressedSize > 0;
    if (useCompression) {
      const savingsLength = dataLen - compressedSize;
      const savingsPercent = (100 * savingsLength) / dataLen;
      if (savingsPercent < MIN_SAVINGS_PERCENT || savingsLength < MIN_SAVINGS_BYTES) {
        useCompression = false;
      }
    }

    if (!useCompression) {
      // Compression not worth it. Clear the REQUEST_RLE bit in ORS
      // bitmap so the server knows the request body is plain.
      const bits = reqBuf.readUInt32BE(headerLen);
      reqBuf.writeUInt32BE((bits & ~ORSBitmap.REQUEST_RLE_COMPRESSED) >>> 0, headerLen);
      return reqBuf;
    }

    // Build the final compressed packet header + compression wrapper.
    const totalCompressed = compressedSize + 50;
    scratch.writeInt32BE(totalCompressed, 0);                  // LL
    reqBuf.copy(scratch, 4, 4, headerTemplateLen);             // bytes 4..39 = header+template
    scratch.writeInt32BE(compressedSize + 10, 40);             // ll = cdata + 10
    scratch.writeUInt16BE(DATA_COMPRESSION_RLE, 44);           // CP = 0x3832
    scratch.writeInt32BE(dataLen, 46);                         // decompressed length

    // Return a right-sized slice.
    return scratch.subarray(0, totalCompressed);
  }

  /**
   * Build execute request (for prepared statements).
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {Buffer} [opts.parameterMarkerData] - encoded parameter values
   * @param {Buffer} [opts.extendedParameterData] - extended format params
   * @param {boolean} [opts.requestOutputData=false] - set ORS RESULT_DATA bit
   *   so the server returns the CALL reply's OUT/INOUT parameter row as
   *   code point 0x380E. Only used by the callable path — DML does not
   *   set this bit.
   * @returns {Buffer}
   */
  static buildExecute(opts) {
    const cps = [];
    const identifierCcsid = opts.identifierCcsid ?? UNICODE_CCSID;
    // JTOpen AS400JDBCStatement.java:879 — cached statement name must
    // accompany the EXECUTE so the server resolves the cached plan.
    if (opts.statementName) cps.push(buildTextCP(CodePoint.PREPARED_STATEMENT_NAME, opts.statementName, identifierCcsid));
    // Packaged execution repeats PACKAGE_NAME. The library is already
    // bound on CREATE_RPB.
    if (opts.packageName) cps.push(buildTextCP(CodePoint.PACKAGE_NAME, opts.packageName, identifierCcsid));
    // Per JTOpen: send PARAMETER_MARKER_BLOCK_IND before parameter data
    if (opts.parameterMarkerData) {
      cps.push(buildShortCP(CodePoint.PARAMETER_MARKER_BLOCK_IND, opts.statementType ?? 0));
      cps.push(buildRawCP(CodePoint.PARAMETER_MARKER_DATA, opts.parameterMarkerData));
    }
    if (opts.extendedParameterData) cps.push(buildRawCP(CodePoint.EXTENDED_COLUMN_DESCRIPTORS, opts.extendedParameterData));

    let orsBitmap = ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.SQLCA;
    if (opts.requestOutputData) orsBitmap |= ORSBitmap.RESULT_DATA;
    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap,
      rpbId: opts.rpbId,
      paramCount: cps.length,
      pmDescriptorHandle: opts.pmDescriptorHandle ?? 0,
    });

    return assemblePacket(RequestID.EXECUTE, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build open-and-describe request (open cursor with column metadata).
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {number} [opts.blockingFactor=0]
   * @param {number} [opts.describeOption=1]
   * @param {number} [opts.scrollable]
   * @param {boolean} [opts.requestResultData=false] - when true, use the
   *   OPEN_DESCRIBE_FETCH request shape so the first block of rows is
   *   returned inline with the open reply.
   * @param {number} [opts.resultDescriptorHandle=0]
   * @param {string} [opts.cursorName]
   * @param {Buffer} [opts.parameterMarkerData]
   * @returns {Buffer}
   */
  static buildOpenAndDescribe(opts) {
    const cps = [];
    const identifierCcsid = opts.identifierCcsid ?? UNICODE_CCSID;
    if (opts.blockingFactor != null) cps.push(buildIntCP(CodePoint.BLOCKING_FACTOR, opts.blockingFactor));
    if (opts.describeOption != null) cps.push(buildByteCP(CodePoint.DESCRIBE_OPTION, opts.describeOption));
    if (opts.openAttributes != null) cps.push(buildByteCP(CodePoint.OPEN_ATTRIBUTES, opts.openAttributes));
    if (opts.scrollable != null) cps.push(buildByteCP(CodePoint.SCROLLABLE_CURSOR_FLAG, opts.scrollable));
    if (opts.cursorName) cps.push(buildTextCP(CodePoint.CURSOR_NAME, opts.cursorName, identifierCcsid));
    // JTOpen AS400JDBCStatement.java:879 — when executing a cached
    // statement from a package, the prepared statement name must be sent
    // so the server can resolve the cached access plan. Without this,
    // the server treats the request as a fresh unnamed open and fails.
    if (opts.statementName) cps.push(buildTextCP(CodePoint.PREPARED_STATEMENT_NAME, opts.statementName, identifierCcsid));
    // Packaged execution repeats PACKAGE_NAME. The library is already
    // bound on CREATE_RPB.
    if (opts.packageName) cps.push(buildTextCP(CodePoint.PACKAGE_NAME, opts.packageName, identifierCcsid));
    // Include inline parameter format (0x3801) if provided
    if (opts.parameterMarkerFormat) cps.push(buildRawCP(0x3801, opts.parameterMarkerFormat));
    // Parameter marker data
    if (opts.parameterMarkerData) {
      cps.push(buildRawCP(CodePoint.PARAMETER_MARKER_DATA, opts.parameterMarkerData));
    }

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    let orsBitmap = ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.SQLCA
                  | ORSBitmap.MESSAGE_ID | ORSBitmap.FIRST_LEVEL_TEXT | ORSBitmap.SECOND_LEVEL_TEXT;
    let requestId = RequestID.OPEN_AND_DESCRIBE;
    if (opts.requestResultData) {
      orsBitmap |= ORSBitmap.DATA_FORMAT | ORSBitmap.RESULT_DATA;
      requestId = RequestID.OPEN_DESCRIBE_FETCH;
    }
    writeTemplate(template, 0, {
      orsBitmap,
      rpbId: opts.rpbId,
      paramCount: cps.length,
      pmDescriptorHandle: opts.pmDescriptorHandle ?? 0,
    });

    return assemblePacket(requestId, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build execute-or-open-and-describe request.
   * Lets the server decide whether to execute (UPDATE/DELETE) or open a cursor (SELECT).
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {number} [opts.blockingFactor=0]
   * @param {number} [opts.describeOption=1]
   * @param {number} [opts.resultDescriptorHandle=0]
   * @param {Buffer} [opts.parameterMarkerData]
   * @param {Buffer} [opts.extendedParameterData]
   * @returns {Buffer}
   */
  static buildExecuteOrOpenDescribe(opts) {
    const cps = [];
    const identifierCcsid = opts.identifierCcsid ?? UNICODE_CCSID;
    if (opts.statementName) {
      cps.push(buildTextCP(CodePoint.PREPARED_STATEMENT_NAME, opts.statementName, identifierCcsid));
    }
    if (opts.cursorName) cps.push(buildTextCP(CodePoint.CURSOR_NAME, opts.cursorName, identifierCcsid));
    if (opts.openAttributes != null) cps.push(buildByteCP(CodePoint.OPEN_ATTRIBUTES, opts.openAttributes));
    if (opts.describeOption != null) cps.push(buildByteCP(CodePoint.DESCRIBE_OPTION, opts.describeOption));
    if (opts.blockingFactor != null) cps.push(buildIntCP(CodePoint.BLOCKING_FACTOR, opts.blockingFactor));
    if (opts.scrollable != null) cps.push(buildByteCP(CodePoint.SCROLLABLE_CURSOR_FLAG, opts.scrollable));
    if (opts.parameterMarkerData) cps.push(buildRawCP(CodePoint.PARAMETER_MARKER_DATA, opts.parameterMarkerData));
    if (opts.extendedParameterData) cps.push(buildRawCP(CodePoint.EXTENDED_COLUMN_DESCRIPTORS, opts.extendedParameterData));

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    let orsBitmap = ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.DATA_FORMAT | ORSBitmap.SQLCA;
    if (opts.requestResultData !== false) {
      orsBitmap |= ORSBitmap.RESULT_DATA;
    }
    writeTemplate(template, 0, {
      orsBitmap,
      rpbId: opts.rpbId,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.EXECUTE_OR_OPEN_DESCRIBE, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build fetch request.
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {number} [opts.fetchCount=1] - rows to fetch
   * @param {number} [opts.scrollOrientation] - FetchScroll value
   * @param {number} [opts.scrollOffset] - row offset for RELATIVE/ABSOLUTE
   * @returns {Buffer}
   */
  static buildFetch(opts) {
    const fetchCount = opts.fetchCount ?? 1;
    const cps = [];
    if (fetchCount > 0) cps.push(buildIntCP(CodePoint.BLOCKING_FACTOR, fetchCount));
    if (opts.scrollOrientation != null) cps.push(buildShortCP(CodePoint.FETCH_SCROLL_OPTION, opts.scrollOrientation));

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.RESULT_DATA | ORSBitmap.SQLCA,
      rpbId: opts.rpbId,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.FETCH, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build close cursor request.
   * @param {object} opts
   * @param {number} opts.rpbId
   * @returns {Buffer}
   */
  static buildCloseCursor(opts) {
    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED,
      rpbId: opts.rpbId,
    });
    return assemblePacket(RequestID.CLOSE_CURSOR, TEMPLATE_LENGTH, template, []);
  }

  /**
   * Build execute-immediate request (prepare + execute in one step).
   *
   * Mirrors JTOpen `AS400JDBCStatement` immediate-execute path,
   * which attaches PACKAGE_NAME / PREPARE_OPTION
   * when the connection's package manager is enabled. Passing
   * `packageName: null` emits the empty PACKAGE_NAME codepoint that
   * JTOpen uses to tell the server "this statement is not eligible
   * for the package, but the connection IS package-bound".
   *
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {string} opts.sqlText
   * @param {number} [opts.statementType]
   * @param {number} [opts.prepareOption]
   * @param {string|null} [opts.packageName]
   * @param {number} [opts.identifierCcsid]
   * @param {number} [opts.translateIndicator]
   * @returns {Buffer}
   */
  static buildExecuteImmediate(opts) {
    const identifierCcsid = opts.identifierCcsid ?? UNICODE_CCSID;
    const cps = [buildTextCP(CodePoint.SQL_STATEMENT_TEXT, opts.sqlText)];
    if (opts.statementType != null) cps.push(buildShortCP(CodePoint.STATEMENT_TYPE, opts.statementType));
    if (opts.prepareOption != null) cps.push(buildByteCP(CodePoint.PREPARE_OPTION, opts.prepareOption));
    if (opts.packageName === null) {
      cps.push(buildEmptyCP(CodePoint.PACKAGE_NAME));
    } else if (typeof opts.packageName === 'string' && opts.packageName.length > 0) {
      cps.push(buildTextCP(CodePoint.PACKAGE_NAME, opts.packageName, identifierCcsid));
    }
    if (opts.translateIndicator != null) cps.push(buildByteCP(CodePoint.TRANSLATE_INDICATOR, opts.translateIndicator));

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.SQLCA,
      rpbId: opts.rpbId,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.EXECUTE_IMMEDIATE, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build prepare-and-execute request.
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {string} opts.sqlText
   * @param {Buffer} [opts.parameterMarkerData]
   * @param {number} [opts.prepareOption]
   * @param {number} [opts.translateIndicator]
   * @returns {Buffer}
   */
  static buildPrepareAndExecute(opts) {
    const cps = [];
    if (opts.statementName) {
      cps.push(buildTextCP(
        CodePoint.PREPARED_STATEMENT_NAME,
        opts.statementName,
        opts.identifierCcsid ?? UNICODE_CCSID,
      ));
    }
    cps.push(buildTextCP(CodePoint.SQL_STATEMENT_TEXT, opts.sqlText));
    if (opts.parameterMarkerData) cps.push(buildRawCP(CodePoint.PARAMETER_MARKER_DATA, opts.parameterMarkerData));
    if (opts.prepareOption != null) cps.push(buildByteCP(CodePoint.PREPARE_OPTION, opts.prepareOption));
    if (opts.translateIndicator != null) cps.push(buildByteCP(CodePoint.TRANSLATE_INDICATOR, opts.translateIndicator));

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED,
      rpbId: opts.rpbId,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.PREPARE_AND_EXECUTE, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build change-descriptor request (register parameter format with server).
   * Must be sent before executing statements with parameter markers.
   *
   * Per JTOpen DBSQLDescriptorDS.java + DBOriginalDataFormat.java:
   * Uses request ID 0x1E00, sends parameter format as code point 0x3801
   * (original format: 8-byte header + 54 bytes per field).
   *
   * @param {object} opts
   * @param {number} opts.rpbId - RPB/statement ID
   * @param {number} opts.descriptorHandle - descriptor handle (typically = rpbId)
   * @param {object[]} opts.descriptors - parameter descriptors from prepare reply
   * @param {number} opts.recordSize - total record size from prepare reply
   * @returns {Buffer}
   */
  static buildChangeDescriptor(opts) {
    const { rpbId, descriptorHandle, descriptors, recordSize } = opts;

    // Construct DBOriginalDataFormat (per AS400JDBCPreparedStatementImpl.changeDescriptor).
    // CRITICAL: The REQUEST format (DBOriginalDataFormat) has a DIFFERENT byte layout
    // than the REPLY format (0x3808). Specifically:
    //   Reply:   byte 6=precision, byte 8=scale, byte 12=dateTimeFormat
    //   Request: byte 6=scale,     byte 8=precision, byte 12=parameterType
    const numFields = descriptors.length;
    const FIELD_SIZE = 54;
    const formatLen = 8 + numFields * FIELD_SIZE;
    const formatBuf = Buffer.alloc(formatLen);

    // Compute fieldLength and recordSize.
    // Per JTOpen: recordSize = parameterTotalSize_ = sum of field lengths (data only).
    // Null indicators are in a separate section of the 0x3811 data, NOT in recordSize.
    const fieldLengths = descriptors.map(desc => desc.rawFieldLength ?? (desc.length || 0));
    const computedRecordSize = fieldLengths.reduce((sum, len) => sum + len, 0);

    // Header (8 bytes)
    formatBuf.writeInt32BE(1, 0);                              // consistencyToken = 1
    formatBuf.writeInt16BE(numFields, 4);                      // numberOfFields
    formatBuf.writeInt16BE(computedRecordSize, 6);             // recordSize (includes indicators)

    // Per-field (54 bytes each) — DBOriginalDataFormat layout
    for (let i = 0; i < numFields; i++) {
      const desc = descriptors[i];
      const off = 8 + i * FIELD_SIZE;
      formatBuf.writeInt16BE(FIELD_SIZE, off);                // +0: fieldDescriptionLength
      formatBuf.writeInt16BE(desc.sqlType | 1, off + 2);     // +2: sqlType (| 1 = nullable)
      formatBuf.writeInt16BE(fieldLengths[i], off + 4);       // +4: fieldLength (wire bytes)
      formatBuf.writeInt16BE(desc.scale ?? 0, off + 6);      // +6: SCALE (not precision!)
      formatBuf.writeInt16BE(desc.precision ?? 0, off + 8);  // +8: PRECISION (not scale!)
      formatBuf.writeUInt16BE(desc.ccsid ?? 0, off + 10);    // +10: ccsid
      formatBuf[off + 12] = 0xF0;                            // +12: parameterType = input
      // +13-27: reserved (zeros from alloc)
      // +28-29: fieldNameLength = 0 (zeros)
      // +30-31: fieldNameCCSID = 0 (zeros)
      // +32-53: fieldName = empty (zeros)
    }

    const cps = [buildRawCP(0x3801, formatBuf)];

    // Per jtopenlite: CHANGE_DESCRIPTOR uses REPLY_RLE_COMPRESSED only,
    // NOT SEND_REPLY_IMMED. The server processes it silently (no reply).
    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED,
      rpbId,
      pmDescriptorHandle: descriptorHandle,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.CHANGE_DESCRIPTOR, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build delete-descriptor request (cleanup when statement closes).
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {number} opts.descriptorHandle
   * @returns {Buffer}
   */
  static buildDeleteDescriptor(opts) {
    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED,
      rpbId: opts.rpbId,
      pmDescriptorHandle: opts.descriptorHandle,
    });
    return assemblePacket(RequestID.DELETE_DESCRIPTOR, TEMPLATE_LENGTH, template, []);
  }

  /**
   * Build a DBOriginalDataFormat buffer for parameter descriptors.
   * Can be used inline in OPEN/EXECUTE requests or in CHANGE_DESCRIPTOR.
   * @param {object[]} descriptors - parameter descriptors from prepare reply
   * @returns {Buffer}
   */
  static buildParameterFormat(descriptors) {
    const numFields = descriptors.length;
    const FIELD_SIZE = 54;
    const formatLen = 8 + numFields * FIELD_SIZE;
    const formatBuf = Buffer.alloc(formatLen);

    const fieldLengths = descriptors.map(desc => desc.rawFieldLength ?? (desc.length || 0));
    const computedRecordSize = fieldLengths.reduce((sum, len) => sum + len, 0);

    formatBuf.writeInt32BE(1, 0);
    formatBuf.writeInt16BE(numFields, 4);
    formatBuf.writeInt16BE(computedRecordSize, 6);

    for (let i = 0; i < numFields; i++) {
      const desc = descriptors[i];
      const off = 8 + i * FIELD_SIZE;
      formatBuf.writeInt16BE(FIELD_SIZE, off);
      formatBuf.writeInt16BE(desc.sqlType | 1, off + 2);
      formatBuf.writeInt16BE(fieldLengths[i], off + 4);
      formatBuf.writeInt16BE(desc.scale ?? 0, off + 6);
      formatBuf.writeInt16BE(desc.precision ?? 0, off + 8);
      formatBuf.writeUInt16BE(desc.ccsid ?? 0, off + 10);
      formatBuf[off + 12] = 0xF0;
    }

    return formatBuf;
  }

  /**
   * Build commit request.
   * @param {object} [opts]
   * @returns {Buffer}
   */
  static buildCommit(opts = {}) {
    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, { orsBitmap: ORSBitmap.SEND_REPLY_IMMED });
    return assemblePacket(RequestID.COMMIT, TEMPLATE_LENGTH, template, []);
  }

  /**
   * Build rollback request.
   * @param {object} [opts]
   * @returns {Buffer}
   */
  static buildRollback(opts = {}) {
    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, { orsBitmap: ORSBitmap.SEND_REPLY_IMMED });
    return assemblePacket(RequestID.ROLLBACK, TEMPLATE_LENGTH, template, []);
  }

  /**
   * Build retrieve LOB data request.
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {number} opts.locatorHandle - server-side LOB locator
   * @param {number} opts.offset - byte offset to start reading
   * @param {number} opts.length - bytes to retrieve
   * @returns {Buffer}
   */
  static buildRetrieveLobData(opts) {
    const locatorBuf = Buffer.alloc(20);
    locatorBuf.writeInt32BE(opts.locatorHandle, 0);
    locatorBuf.writeInt32BE(opts.offset, 4);
    locatorBuf.writeInt32BE(opts.length, 8);
    locatorBuf.writeInt32BE(0, 12); // reserved
    locatorBuf.writeInt32BE(0, 16); // reserved

    const cps = [buildRawCP(CodePoint.LOB_LOCATOR_HANDLE, locatorBuf)];

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.RESULT_DATA,
      rpbId: opts.rpbId,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.RETRIEVE_LOB_DATA, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build free LOB locator request.
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {number} opts.locatorHandle
   * @returns {Buffer}
   */
  static buildFreeLob(opts) {
    const handleBuf = Buffer.alloc(4);
    handleBuf.writeInt32BE(opts.locatorHandle, 0);
    const cps = [buildRawCP(CodePoint.LOB_LOCATOR_HANDLE, handleBuf)];

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED,
      rpbId: opts.rpbId,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.FREE_LOB, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build execute-or-open request (no describe).
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {Buffer} [opts.parameterMarkerData]
   * @param {number} [opts.blockingFactor]
   * @returns {Buffer}
   */
  static buildExecuteOrOpen(opts) {
    const cps = [];
    if (opts.parameterMarkerData) cps.push(buildRawCP(CodePoint.PARAMETER_MARKER_DATA, opts.parameterMarkerData));
    if (opts.blockingFactor != null) cps.push(buildIntCP(CodePoint.BLOCKING_FACTOR, opts.blockingFactor));

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.SQLCA,
      rpbId: opts.rpbId,
      paramCount: cps.length,
    });

    return assemblePacket(RequestID.EXECUTE_OR_OPEN, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build stream fetch request.
   * @param {object} opts
   * @param {number} opts.rpbId
   * @param {number} [opts.maxRows=0] - max rows (0 = unlimited)
   * @returns {Buffer}
   */
  static buildStreamFetch(opts) {
    const cps = [];
    const maxRows = opts.maxRows ?? 0;
    if (maxRows > 0) cps.push(buildIntCP(CodePoint.BLOCKING_FACTOR, maxRows));

    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED | ORSBitmap.RESULT_DATA,
      rpbId: opts.rpbId,
      paramCount: cps.length,
    });
    return assemblePacket(RequestID.STREAM_FETCH, TEMPLATE_LENGTH, template, cps);
  }

  /**
   * Build end stream fetch request.
   * @param {object} opts
   * @param {number} opts.rpbId
   * @returns {Buffer}
   */
  static buildEndStreamFetch(opts) {
    const template = Buffer.alloc(TEMPLATE_LENGTH);
    writeTemplate(template, 0, {
      orsBitmap: ORSBitmap.SEND_REPLY_IMMED,
      rpbId: opts.rpbId,
    });
    return assemblePacket(RequestID.END_STREAM_FETCH, TEMPLATE_LENGTH, template, []);
  }
}
