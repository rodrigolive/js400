/**
 * Database reply datastream parsers.
 *
 * Parses binary reply buffers from the IBM i database host server.
 * Extracts headers, reply template, SQLCA, column descriptors, row data, and code points.
 *
 * Reply template format (20 bytes, per jtopenlite DatabaseConnection.readReplyHeader):
 *   +0:  int32  ORS bitmap (what data the server is returning)
 *   +4:  int32  Compressed (first byte count, last 3 reserved)
 *   +8:  int16  Return ORS handle
 *   +10: int16  Return data function ID
 *   +12: int16  Request data function ID
 *   +14: int16  RC class (0=success, non-zero=error/warning)
 *   +16: int32  RC class return code
 *
 * Upstream: DBBaseReplyDS.java, DBReplyRequestedDS.java, jtopenlite DatabaseConnection.java
 * @module db/protocol/DBReplyDS
 */

import { DataStream } from '../../transport/DataStream.js';
import { DatastreamError, SqlError } from '../../core/errors.js';
import { CharConverter } from '../../ccsid/CharConverter.js';

/** SQLCA size in the wire protocol (without SQLCAID/SQLCABC header). */
const SQLCA_LENGTH = 124;

/**
 * Reply code points (different meanings from request code points!).
 */
const REPLY_CP = {
  MESSAGE_ID:               0x3801,
  FIRST_LEVEL_TEXT:         0x3802,
  SECOND_LEVEL_TEXT:        0x3803,
  SERVER_ATTRIBUTES:        0x3804,
  DATA_FORMAT:              0x3805,
  RESULT_DATA_DS0:          0x3806,  // Result data at DS level 0
  SQLCA:                    0x3807,
  PARAMETER_MARKER_FORMAT:  0x3808,
  RESULT_DATA:              0x380E,
  EXT_COLUMN_DESCRIPTORS:   0x3811,
  SUPER_EXT_DATA_FORMAT:    0x3812,
  RLE_COMPRESSED:           0x3832,
  DATASTREAM_LEVEL:         0x3A01,
};

/**
 * Parse a complete database reply buffer.
 *
 * @param {Buffer} buf - raw reply datastream
 * @returns {DatabaseReply}
 */
export function parseReply(buf) {
  if (!buf || buf.length < DataStream.HEADER_LENGTH) {
    throw new DatastreamError('Database reply too short', { bufferOffsets: { start: 0, end: buf?.length ?? 0 } });
  }

  const header = DataStream.parseHeader(buf, 0);
  const templateEnd = DataStream.HEADER_LENGTH + header.templateLen;
  const template = buf.subarray(DataStream.HEADER_LENGTH, templateEnd);

  const codePoints = new Map();
  let offset = templateEnd;
  while (offset + 6 <= buf.length) {
    const ll = buf.readInt32BE(offset);
    if (ll < 6) break;
    const cp = buf.readUInt16BE(offset + 4);
    const dataStart = offset + 6;
    const dataEnd = offset + ll;
    if (dataEnd > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);
    if (!codePoints.has(cp)) {
      codePoints.set(cp, []);
    }
    codePoints.get(cp).push(data);
    offset = dataEnd;
  }

  return {
    header,
    template,
    codePoints,
    raw: buf,
  };
}

/**
 * Parse the 20-byte reply template.
 *
 * @param {Buffer} template
 * @returns {{ orsBitmap: number, compressed: number, returnOrsHandle: number,
 *             returnDataFuncId: number, requestDataFuncId: number,
 *             rcClass: number, rcReturnCode: number }}
 */
export function parseReplyTemplate(template) {
  if (!template || template.length < 20) {
    return { orsBitmap: 0, compressed: 0, returnOrsHandle: 0,
             returnDataFuncId: 0, requestDataFuncId: 0, rcClass: 0, rcReturnCode: 0 };
  }
  return {
    orsBitmap:          template.readUInt32BE(0),
    compressed:         template.readInt32BE(4),
    returnOrsHandle:    template.readInt16BE(8),
    returnDataFuncId:   template.readUInt16BE(10),
    requestDataFuncId:  template.readUInt16BE(12),
    rcClass:            template.readInt16BE(14),
    rcReturnCode:       template.readInt32BE(16),
  };
}

/**
 * Get the first data buffer for a given code point.
 * @param {DatabaseReply} reply
 * @param {number} cp
 * @returns {Buffer|null}
 */
export function getCodePointData(reply, cp) {
  const arr = reply.codePoints.get(cp);
  return arr && arr.length > 0 ? arr[0] : null;
}

/**
 * Check if a code point is present.
 * @param {DatabaseReply} reply
 * @param {number} cp
 * @returns {boolean}
 */
export function hasCodePoint(reply, cp) {
  return reply.codePoints.has(cp);
}

/**
 * Parse SQLCA from a buffer at the given offset.
 *
 * SQLCA wire layout (124 bytes, no SQLCAID/SQLCABC header):
 *   0-3:     SQLCODE    (int32, signed)
 *   4-5:     SQLERRML   (int16, message token length)
 *   6-75:    SQLERRMC   (70 bytes, message tokens in server CCSID)
 *   76-83:   SQLERRP    (8 bytes, product identifier)
 *   84-107:  SQLERRD[0-5] (6 x int32)
 *   108-118: SQLWARN[0-A] (11 bytes, warning flags)
 *   119-123: SQLSTATE   (5 bytes, ASCII/EBCDIC)
 *
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @param {number} [serverCCSID=37] - CCSID for SQLERRMC/SQLERRP/SQLSTATE
 * @returns {SQLCA}
 */
export function parseSQLCA(buf, offset = 0, serverCCSID = 37) {
  if (buf.length < offset + SQLCA_LENGTH) {
    return createEmptySQLCA();
  }

  const sqlCode = buf.readInt32BE(offset);
  const errml = buf.readUInt16BE(offset + 4);
  const errmc = buf.subarray(offset + 6, offset + 76);
  const errp = buf.subarray(offset + 76, offset + 84);

  const sqlerrd = new Array(6);
  for (let i = 0; i < 6; i++) {
    sqlerrd[i] = buf.readInt32BE(offset + 84 + i * 4);
  }

  const sqlwarn = new Array(11);
  for (let i = 0; i < 11; i++) {
    sqlwarn[i] = buf[offset + 108 + i];
  }

  const sqlstateRaw = buf.subarray(offset + 119, offset + 124);

  let messageTokens = '';
  if (errml > 0 && errml <= 70) {
    try {
      messageTokens = CharConverter.byteArrayToString(errmc, 0, errml, serverCCSID);
    } catch {
      messageTokens = errmc.subarray(0, errml).toString('latin1');
    }
  }

  let productId = '';
  try {
    productId = CharConverter.byteArrayToString(errp, 0, 8, serverCCSID).trim();
  } catch {
    productId = errp.toString('latin1').trim();
  }

  let sqlState = '';
  try {
    sqlState = CharConverter.byteArrayToString(sqlstateRaw, 0, 5, serverCCSID).trim();
  } catch {
    sqlState = sqlstateRaw.toString('latin1').trim();
  }

  return {
    sqlCode,
    sqlState,
    messageTokens,
    productId,
    sqlerrd,
    sqlwarn,
    rowCount: sqlerrd[2],
    isError: sqlCode < 0,
    isWarning: sqlCode > 0,
    isSuccess: sqlCode === 0,
  };
}

/**
 * Create an empty SQLCA with success defaults.
 * @returns {SQLCA}
 */
function createEmptySQLCA() {
  return {
    sqlCode: 0,
    sqlState: '00000',
    messageTokens: '',
    productId: '',
    sqlerrd: [0, 0, 0, 0, 0, 0],
    sqlwarn: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rowCount: 0,
    isError: false,
    isWarning: false,
    isSuccess: true,
  };
}

/**
 * Extract error message text from reply code points.
 * @param {Map} codePoints
 * @param {number} serverCCSID
 * @returns {{ messageId: string, firstLevelText: string, secondLevelText: string }}
 */
function extractErrorMessages(codePoints, serverCCSID) {
  let messageId = '';
  let firstLevelText = '';
  let secondLevelText = '';

  const msgIdData = codePoints.get(REPLY_CP.MESSAGE_ID);
  if (msgIdData && msgIdData.length > 0 && msgIdData[0].length >= 2) {
    const d = msgIdData[0];
    const ccsid = d.readUInt16BE(0);
    const textBuf = d.subarray(2);
    try {
      messageId = CharConverter.byteArrayToString(textBuf, 0, textBuf.length, ccsid || serverCCSID).trim();
    } catch {
      messageId = textBuf.toString('latin1').trim();
    }
  }

  const firstData = codePoints.get(REPLY_CP.FIRST_LEVEL_TEXT);
  if (firstData && firstData.length > 0 && firstData[0].length >= 4) {
    const d = firstData[0];
    const ccsid = d.readUInt16BE(0);
    const len = d.readUInt16BE(2);
    const textBuf = d.subarray(4);
    try {
      firstLevelText = CharConverter.byteArrayToString(textBuf, 0, textBuf.length, ccsid || serverCCSID).trim();
    } catch {
      firstLevelText = textBuf.toString('latin1').trim();
    }
  }

  const secondData = codePoints.get(REPLY_CP.SECOND_LEVEL_TEXT);
  if (secondData && secondData.length > 0 && secondData[0].length >= 4) {
    const d = secondData[0];
    const ccsid = d.readUInt16BE(0);
    const len = d.readUInt16BE(2);
    const textBuf = d.subarray(4);
    try {
      secondLevelText = CharConverter.byteArrayToString(textBuf, 0, textBuf.length, ccsid || serverCCSID).trim();
    } catch {
      secondLevelText = textBuf.toString('latin1').trim();
    }
  }

  return { messageId, firstLevelText, secondLevelText };
}

/**
 * Parse the set/exchange server attributes reply.
 *
 * For SET_SERVER_ATTRIBUTES (0x1F80), the reply template uses the standard
 * 20-byte reply format. Server attributes come in code point 0x3804.
 *
 * @param {Buffer} buf - raw reply
 * @returns {ExchangeAttributesReply}
 */
export function parseExchangeAttributes(buf) {
  const reply = parseReply(buf);
  const tmpl = parseReplyTemplate(reply.template);

  let serverCCSID = 37;
  let serverDatastreamLevel = 0;
  let serverAttributes = 0;

  // Check for 0x3804 code point (server attributes from SET_SERVER_ATTRIBUTES)
  const attrData = getCodePointData(reply, REPLY_CP.SERVER_ATTRIBUTES);
  if (attrData && attrData.length >= 23) {
    serverCCSID = attrData.readUInt16BE(21);
    serverAttributes = attrData.readUInt16BE(0);
  }

  // Check for CLIENT_DATASTREAM_LEVEL reply (0x3A01)
  const dsLevelData = getCodePointData(reply, REPLY_CP.DATASTREAM_LEVEL);
  if (dsLevelData && dsLevelData.length >= 4) {
    serverDatastreamLevel = dsLevelData.readInt32BE(0);
  } else if (dsLevelData && dsLevelData.length >= 2) {
    serverDatastreamLevel = dsLevelData.readUInt16BE(0);
  }

  return {
    serverAttributes,
    serverCCSID,
    serverDatastreamLevel,
    accessLevel: 0,
    header: reply.header,
    codePoints: reply.codePoints,
    rcClass: tmpl.rcClass,
    rcReturnCode: tmpl.rcReturnCode,
  };
}

/**
 * Parse an operation reply.
 *
 * The reply template contains RC class/return code for error detection.
 * The SQLCA (if requested) comes as code point 0x3807, NOT in the template.
 *
 * @param {Buffer} buf - raw reply
 * @param {object} [opts]
 * @param {number} [opts.serverCCSID=37]
 * @returns {OperationReply}
 */
export function parseOperationReply(buf, opts = {}) {
  const reply = parseReply(buf);
  const serverCCSID = opts.serverCCSID ?? 37;
  const tmpl = parseReplyTemplate(reply.template);

  // Try to parse SQLCA from code point 0x3807.
  // The code point data includes SQLCAID(8) + SQLCABC(4) header before the
  // 124-byte SQLCA body, so total is 136 bytes and body starts at offset 12.
  let sqlca;
  const sqlcaData = getCodePointData(reply, REPLY_CP.SQLCA);
  if (sqlcaData && sqlcaData.length >= 12 + SQLCA_LENGTH) {
    sqlca = parseSQLCA(sqlcaData, 12, serverCCSID);
  } else if (sqlcaData && sqlcaData.length >= SQLCA_LENGTH) {
    sqlca = parseSQLCA(sqlcaData, 0, serverCCSID);
  } else {
    sqlca = createEmptySQLCA();
  }

  // Check reply template for errors (rcClass == 1 means error;
  // rcClass == 2 means "data returned" which is success).
  if (tmpl.rcClass === 1 && tmpl.rcReturnCode < 0) {
    // Server reported an error via the reply template
    const msgs = extractErrorMessages(reply.codePoints, serverCCSID);
    // If we have an SQLCA, it already captures the error.
    // If not, synthesize one from the template error info.
    if (sqlca.isSuccess && !sqlca.isError) {
      sqlca = {
        ...sqlca,
        sqlCode: tmpl.rcReturnCode,
        sqlState: msgs.messageId || `RC${tmpl.rcClass}`,
        messageTokens: msgs.firstLevelText || msgs.secondLevelText || `RC class ${tmpl.rcClass}, return code ${tmpl.rcReturnCode}`,
        isError: true,
        isSuccess: false,
      };
    }
  }

  return {
    header: reply.header,
    template: reply.template,
    replyTemplate: tmpl,
    sqlca,
    codePoints: reply.codePoints,
    raw: reply.raw,
  };
}

/**
 * Parse a fetch reply containing row data.
 * @param {Buffer} buf
 * @param {object} [opts]
 * @param {number} [opts.serverCCSID=37]
 * @returns {FetchReply}
 */
export function parseFetchReply(buf, opts = {}) {
  const opReply = parseOperationReply(buf, opts);

  // Result data may appear in 0x380E (standard) or 0x3806 (DS level 0)
  let rowDataBuffers = opReply.codePoints.get(REPLY_CP.RESULT_DATA) || [];
  if (rowDataBuffers.length === 0) {
    rowDataBuffers = opReply.codePoints.get(REPLY_CP.RESULT_DATA_DS0) || [];
  }
  const extDescriptors = opReply.codePoints.get(REPLY_CP.SUPER_EXT_DATA_FORMAT) || [];

  return {
    ...opReply,
    rowDataBuffers,
    extDescriptors,
    endOfData: opReply.sqlca.sqlCode === 100,
  };
}

/**
 * Throw a SqlError if the SQLCA indicates an error.
 * @param {SQLCA} sqlca
 * @param {string} [context] - description of what operation was attempted
 */
export function throwIfError(sqlca, context) {
  if (sqlca.isError) {
    const msg = context
      ? `${context}: SQLCODE ${sqlca.sqlCode} SQLSTATE ${sqlca.sqlState} — ${sqlca.messageTokens}`
      : `SQLCODE ${sqlca.sqlCode} SQLSTATE ${sqlca.sqlState} — ${sqlca.messageTokens}`;
    throw new SqlError(msg, {
      returnCode: sqlca.sqlCode,
      messageId: sqlca.sqlState,
      hostService: 'database',
      requestMetadata: {
        sqlCode: sqlca.sqlCode,
        sqlState: sqlca.sqlState,
        messageTokens: sqlca.messageTokens,
        rowCount: sqlca.rowCount,
        sqlerrd: sqlca.sqlerrd,
      },
    });
  }
}

/**
 * Decode a text code point from a reply.
 * Reply text CPs have: CCSID(2) + data
 * @param {Buffer} data - code point data (after LL/CP)
 * @returns {string}
 */
export function decodeTextCodePoint(data) {
  if (!data || data.length < 2) return '';
  const ccsid = data.readUInt16BE(0);
  const textBuf = data.subarray(2);
  if (ccsid === 13488 || ccsid === 1200) {
    return decodeUtf16BE(textBuf);
  }
  try {
    return CharConverter.byteArrayToString(textBuf, 0, textBuf.length, ccsid || 37);
  } catch {
    return textBuf.toString('latin1');
  }
}

/**
 * Decode UTF-16BE buffer to JS string.
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeUtf16BE(buf) {
  const chars = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    chars.push(String.fromCharCode(buf.readUInt16BE(i)));
  }
  return chars.join('');
}

/** Re-export SQLCA_LENGTH for external use. */
export { SQLCA_LENGTH };

export class DBReplyDS {
  static parseReply = parseReply;
  static parseReplyTemplate = parseReplyTemplate;
  static parseExchangeAttributes = parseExchangeAttributes;
  static parseOperationReply = parseOperationReply;
  static parseFetchReply = parseFetchReply;
  static parseSQLCA = parseSQLCA;
  static throwIfError = throwIfError;
  static getCodePointData = getCodePointData;
  static hasCodePoint = hasCodePoint;
  static decodeTextCodePoint = decodeTextCodePoint;
  static SQLCA_LENGTH = SQLCA_LENGTH;
}
