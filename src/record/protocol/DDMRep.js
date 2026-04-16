/**
 * DDM reply parsers.
 *
 * Parses DDM reply datastreams. DDM replies use the same 6-byte DSS header
 * as requests, followed by DDM objects containing reply data and parameters.
 *
 * Upstream: DDMReplyDataStream.java, DDMReadReplyDataStream.java,
 *           DDMASPReplyDataStream.java, DDMACCSECReplyDataStream.java,
 *           DDMSECCHKReplyDataStream.java
 * @module record/protocol/DDMRep
 */

import { DatastreamError } from '../../core/errors.js';
import { CharConverter } from '../../ccsid/CharConverter.js';
import { CP } from './DDMReq.js';

/**
 * Parse the 6-byte DSS header from a DDM reply.
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @returns {{ length: number, flags: number, type: number, correlation: number }}
 */
function parseDSSHeader(buf, offset = 0) {
  if (buf.length - offset < 6) {
    throw new DatastreamError('DDM reply too short for DSS header');
  }
  return {
    length:      buf.readUInt16BE(offset),
    flags:       buf[offset + 2],
    type:        buf[offset + 3],
    correlation: buf.readUInt16BE(offset + 4),
  };
}

/**
 * Parse DDM parameters (LL/CP pairs) from a buffer region.
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {Map<number, Buffer[]>}
 */
function parseParams(buf, start, end) {
  const map = new Map();
  let offset = start;
  while (offset + 4 <= end) {
    const ll = buf.readUInt16BE(offset);
    if (ll < 4 || offset + ll > end) break;
    const cp = buf.readUInt16BE(offset + 2);
    const data = buf.subarray(offset + 4, offset + ll);
    if (!map.has(cp)) map.set(cp, []);
    map.get(cp).push(data);
    offset += ll;
  }
  return map;
}

/**
 * Get the first parameter value for a code point.
 * @param {Map<number, Buffer[]>} params
 * @param {number} codePoint
 * @returns {Buffer|null}
 */
function getParam(params, codePoint) {
  const items = params.get(codePoint);
  return items && items.length > 0 ? items[0] : null;
}

export class DDMRep {

  /**
   * Parse the DDM reply code point from a raw buffer.
   * @param {Buffer} buf
   * @returns {number} Code point of the first DDM object in the reply
   */
  static getReplyCodePoint(buf) {
    if (!buf || buf.length < 10) return 0;
    // After 6-byte DSS header, the DDM object starts at offset 6
    // DDM object: 2-byte length + 2-byte code point
    return buf.readUInt16BE(8);
  }

  /**
   * Parse a complete DDM reply into its components.
   * @param {Buffer} buf
   * @returns {{
   *   dss: { length: number, flags: number, type: number, correlation: number },
   *   codePoint: number,
   *   objectLength: number,
   *   params: Map<number, Buffer[]>,
   *   raw: Buffer,
   * }}
   */
  static parse(buf) {
    const dss = parseDSSHeader(buf);

    if (buf.length < 10) {
      return { dss, codePoint: 0, objectLength: 0, params: new Map(), raw: buf };
    }

    const objectLength = buf.readUInt16BE(6);
    const codePoint = buf.readUInt16BE(8);

    // Parse parameters within the DDM object (after the 4-byte object header)
    const objEnd = Math.min(6 + objectLength, buf.length);
    const params = parseParams(buf, 10, objEnd);

    return { dss, codePoint, objectLength, params, raw: buf };
  }

  /**
   * Parse an Exchange Server Attributes reply (EXCSATRD).
   * @param {Buffer} buf
   * @returns {{
   *   serverClassName: string,
   *   serverName: string,
   *   serverReleaseLevel: string,
   *   externalName: string,
   * }}
   */
  static parseExchangeAttributes(buf) {
    const { params } = DDMRep.parse(buf);
    const conv = new CharConverter(37);

    const result = {
      serverClassName: '',
      serverName: '',
      serverReleaseLevel: '',
      externalName: '',
    };

    const srvclsnm = getParam(params, CP.SRVCLSNM);
    if (srvclsnm) result.serverClassName = conv.byteArrayToString(srvclsnm, 0, srvclsnm.length).trim();

    const srvnam = getParam(params, CP.SRVNAM);
    if (srvnam) result.serverName = conv.byteArrayToString(srvnam, 0, srvnam.length).trim();

    const srvrlslv = getParam(params, CP.SRVRLSLV);
    if (srvrlslv) result.serverReleaseLevel = conv.byteArrayToString(srvrlslv, 0, srvrlslv.length).trim();

    const extnam = getParam(params, CP.EXTNAM);
    if (extnam) result.externalName = conv.byteArrayToString(extnam, 0, extnam.length).trim();

    return result;
  }

  /**
   * Parse an Access Security reply (ACCSECRD).
   * @param {Buffer} buf
   * @returns {{ securityMechanism: number, securityToken: Buffer|null }}
   */
  static parseAccessSecurity(buf) {
    const { params } = DDMRep.parse(buf);

    let securityMechanism = 0;
    const secmec = getParam(params, CP.SECMEC);
    if (secmec && secmec.length >= 2) {
      securityMechanism = secmec.readUInt16BE(0);
    }

    const securityToken = getParam(params, CP.SECTKN);

    return { securityMechanism, securityToken };
  }

  /**
   * Parse a Security Check reply (SECCHKRM).
   * @param {Buffer} buf
   * @returns {{ securityCheckCode: number }}
   */
  static parseSecurityCheck(buf) {
    const { params } = DDMRep.parse(buf);

    let securityCheckCode = 0;
    const secchkcd = getParam(params, CP.SECCHKCD);
    if (secchkcd && secchkcd.length >= 1) {
      securityCheckCode = secchkcd[0];
    }

    return { securityCheckCode };
  }

  /**
   * Parse an S/38 Open reply.
   * Returns the I/O feedback area and any message data.
   * @param {Buffer} buf
   * @returns {{
   *   success: boolean,
   *   recordLength: number,
   *   recordCount: number,
   *   accessType: number,
   *   keyLength: number,
   *   messageId: string,
   *   iofb: Buffer|null,
   * }}
   */
  static parseOpen(buf) {
    const { codePoint, params } = DDMRep.parse(buf);

    const result = {
      success: true,
      recordLength: 0,
      recordCount: 0,
      accessType: 0,
      keyLength: 0,
      messageId: '',
      iofb: null,
    };

    // Check for error
    const msgid = getParam(params, CP.S38MSGID);
    if (msgid) {
      const conv = new CharConverter(37);
      result.messageId = conv.byteArrayToString(msgid, 0, msgid.length).trim();
      result.success = false;
      return result;
    }

    // Parse I/O feedback
    const iofb = getParam(params, CP.S38IOFB);
    if (iofb) {
      result.iofb = iofb;
      // I/O feedback layout varies but typically:
      //   Record length at offset 0 (4 bytes)
      //   Record count at offset 4 (4 bytes)
      //   Access type at offset 8 (2 bytes)
      //   Key length at offset 10 (2 bytes)
      if (iofb.length >= 4) result.recordLength = iofb.readUInt32BE(0);
      if (iofb.length >= 8) result.recordCount = iofb.readUInt32BE(4);
      if (iofb.length >= 10) result.accessType = iofb.readUInt16BE(8);
      if (iofb.length >= 12) result.keyLength = iofb.readUInt16BE(10);
    }

    return result;
  }

  /**
   * Parse an S/38 Get (read) reply.
   * Returns the data buffer, record number, and null indicators.
   * @param {Buffer} buf
   * @returns {{
   *   success: boolean,
   *   data: Buffer|null,
   *   recordNumber: number,
   *   nullMap: Buffer|null,
   *   messageId: string,
   *   endOfFile: boolean,
   * }}
   */
  static parseGet(buf) {
    const { codePoint, params } = DDMRep.parse(buf);

    const result = {
      success: true,
      data: null,
      recordNumber: 0,
      nullMap: null,
      messageId: '',
      endOfFile: false,
    };

    // Check for message / error
    const msgid = getParam(params, CP.S38MSGID);
    if (msgid) {
      const conv = new CharConverter(37);
      result.messageId = conv.byteArrayToString(msgid, 0, msgid.length).trim();
      result.success = false;
      // CPF5001 = end of file
      if (result.messageId === 'CPF5001' || result.messageId === 'CPF5025') {
        result.endOfFile = true;
      }
      return result;
    }

    // Data buffer
    const dataBuf = getParam(params, CP.S38BUF);
    if (dataBuf) {
      result.data = dataBuf;
    }

    // Record number
    const recnb = getParam(params, CP.S38RECNB);
    if (recnb && recnb.length >= 4) {
      result.recordNumber = recnb.readUInt32BE(0);
    }

    // Null value indicators
    const nullv = getParam(params, CP.S38NULLV);
    if (nullv) {
      result.nullMap = nullv;
    }

    return result;
  }

  /**
   * Parse an S/38 Put (write) reply.
   * @param {Buffer} buf
   * @returns {{ success: boolean, recordNumber: number, messageId: string }}
   */
  static parsePut(buf) {
    const { params } = DDMRep.parse(buf);

    const result = { success: true, recordNumber: 0, messageId: '' };

    const msgid = getParam(params, CP.S38MSGID);
    if (msgid) {
      const conv = new CharConverter(37);
      result.messageId = conv.byteArrayToString(msgid, 0, msgid.length).trim();
      result.success = false;
      return result;
    }

    const recnb = getParam(params, CP.S38RECNB);
    if (recnb && recnb.length >= 4) {
      result.recordNumber = recnb.readUInt32BE(0);
    }

    return result;
  }

  /**
   * Parse an S/38 Update reply.
   * @param {Buffer} buf
   * @returns {{ success: boolean, messageId: string }}
   */
  static parseUpdate(buf) {
    const { params } = DDMRep.parse(buf);

    const msgid = getParam(params, CP.S38MSGID);
    if (msgid) {
      const conv = new CharConverter(37);
      return {
        success: false,
        messageId: conv.byteArrayToString(msgid, 0, msgid.length).trim(),
      };
    }

    return { success: true, messageId: '' };
  }

  /**
   * Parse an S/38 Delete reply.
   * @param {Buffer} buf
   * @returns {{ success: boolean, messageId: string }}
   */
  static parseDelete(buf) {
    return DDMRep.parseUpdate(buf);
  }

  /**
   * Parse an S/38 Close reply.
   * @param {Buffer} buf
   * @returns {{ success: boolean, messageId: string }}
   */
  static parseClose(buf) {
    return DDMRep.parseUpdate(buf);
  }

  /**
   * Read a complete DDM frame from a readable stream.
   * DDM frames start with a 2-byte length prefix.
   * @param {{ read: (n: number) => Buffer|null }} readable
   * @returns {Promise<Buffer>}
   */
  static async readFrame(readable) {
    const lenBuf = await DDMRep.#readExact(readable, 2);
    const totalLen = lenBuf.readUInt16BE(0);
    if (totalLen <= 2) return lenBuf;

    const rest = await DDMRep.#readExact(readable, totalLen - 2);
    const frame = Buffer.alloc(totalLen);
    lenBuf.copy(frame, 0);
    rest.copy(frame, 2);
    return frame;
  }

  /**
   * Read exactly n bytes from a stream.
   * @param {object} readable
   * @param {number} n
   * @returns {Promise<Buffer>}
   */
  static #readExact(readable, n) {
    return new Promise((resolve, reject) => {
      const tryRead = () => {
        const chunk = readable.read(n);
        if (chunk && chunk.length === n) {
          resolve(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return;
        }
        if (chunk && chunk.length > 0) {
          const parts = [chunk];
          let got = chunk.length;
          const onReadable = () => {
            while (got < n) {
              const more = readable.read(n - got);
              if (!more) return;
              parts.push(more);
              got += more.length;
            }
            readable.removeListener('readable', onReadable);
            readable.removeListener('error', onError);
            readable.removeListener('end', onEnd);
            resolve(Buffer.concat(parts, n));
          };
          const onError = (err) => {
            readable.removeListener('readable', onReadable);
            readable.removeListener('end', onEnd);
            reject(err);
          };
          const onEnd = () => {
            readable.removeListener('readable', onReadable);
            readable.removeListener('error', onError);
            reject(new DatastreamError(`Stream ended after ${got} of ${n} bytes`));
          };
          readable.on('readable', onReadable);
          readable.on('error', onError);
          readable.on('end', onEnd);
          return;
        }
        const onReadable = () => {
          readable.removeListener('readable', onReadable);
          readable.removeListener('error', onError);
          readable.removeListener('end', onEnd);
          tryRead();
        };
        const onError = (err) => {
          readable.removeListener('readable', onReadable);
          readable.removeListener('end', onEnd);
          reject(err);
        };
        const onEnd = () => {
          readable.removeListener('readable', onReadable);
          readable.removeListener('error', onError);
          reject(new DatastreamError(`Stream ended before ${n} bytes available`));
        };
        readable.on('readable', onReadable);
        readable.on('error', onError);
        readable.on('end', onEnd);
      };
      tryRead();
    });
  }
}

// Export parser helpers for testing
DDMRep.parseDSSHeader = parseDSSHeader;
DDMRep.parseParams = parseParams;
