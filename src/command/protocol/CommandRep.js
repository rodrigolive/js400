/**
 * Command server reply parsers.
 *
 * Parses replies from:
 *   - Exchange Attributes (0x8001)
 *   - Run Command / Call Program (0x8002/0x8003)
 *
 * Upstream: RemoteCommandImplRemote.java,
 *           RCExchangeAttributesReplyDataStream.java,
 *           RCCallProgramReplyDataStream.java
 * @module command/protocol/CommandRep
 */

import { DatastreamError } from '../../core/errors.js';
import { AS400Message } from '../../core/AS400Message.js';
import { CharConverter } from '../../ccsid/CharConverter.js';

/** Reply IDs. */
export const REP_EXCHANGE_ATTRIBUTES = 0x8001;
export const REP_RUN_COMMAND = 0x8002;
export const REP_CALL_PROGRAM = 0x8003;

/** Return code constants. */
export const RC_SUCCESS = 0x0000;
export const RC_COMMAND_FAILED = 0x0400;
export const RC_PROGRAM_NOT_FOUND = 0x0500;
export const RC_PROGRAM_ERROR = 0x0501;

export class CommandRep {

  /**
   * Parse an exchange-attributes reply.
   *
   * @param {Buffer} buf
   * @returns {{ returnCode: number, datastreamLevel: number, ccsid: number }}
   */
  static parseExchangeAttributes(buf) {
    if (!buf || buf.length < 22) {
      throw new DatastreamError('Exchange attributes reply too short');
    }

    const returnCode = buf.readUInt16BE(20);
    let datastreamLevel = 0;
    let ccsid = 0;

    // Template area: RC(2) + datastreamLevel(2)
    if (buf.length >= 24) {
      datastreamLevel = buf.readUInt16BE(22);
    }
    // CCSID may be in template at offset 24
    if (buf.length >= 28) {
      ccsid = buf.readUInt32BE(24);
    }

    return { returnCode, datastreamLevel, ccsid };
  }

  /**
   * Parse a call-program or run-command reply.
   *
   * @param {Buffer} buf
   * @param {object} [opts]
   * @param {number} [opts.datastreamLevel=10] - Negotiated level
   * @param {number} [opts.ccsid=37] - Server CCSID for text decoding
   * @param {number} [opts.parameterCount=0] - Expected output params
   * @returns {{
   *   returnCode: number,
   *   messageCount: number,
   *   messages: AS400Message[],
   *   outputParameters: Buffer[],
   * }}
   */
  static parseCallReply(buf, opts = {}) {
    const {
      datastreamLevel = 10,
      ccsid = 37,
      parameterCount = 0,
    } = opts;

    if (!buf || buf.length < 24) {
      throw new DatastreamError('Call/command reply too short');
    }

    const returnCode = buf.readUInt16BE(20);
    const messageCount = buf.readUInt16BE(22);

    let offset = 24;
    const outputParameters = [];
    const messages = [];

    // Parse output parameter blocks (for program calls)
    for (let i = 0; i < parameterCount && offset + 12 <= buf.length; i++) {
      const ll = buf.readUInt32BE(offset);
      if (ll < 12 || offset + ll > buf.length) break;

      const maxLen = buf.readUInt32BE(offset + 6);
      const usage = buf.readUInt16BE(offset + 10);

      // Extract data portion
      const dataStart = offset + 12;
      const dataLen = ll - 12;

      if (dataLen > 0) {
        const paramData = Buffer.alloc(dataLen);
        buf.copy(paramData, 0, dataStart, dataStart + dataLen);
        outputParameters.push(paramData);
      } else {
        outputParameters.push(Buffer.alloc(0));
      }

      offset += ll;
    }

    // Parse messages
    for (let i = 0; i < messageCount && offset < buf.length; i++) {
      const msg = CommandRep.#parseOneMessage(buf, offset, datastreamLevel, ccsid);
      if (!msg) break;
      messages.push(msg.message);
      offset = msg.nextOffset;
    }

    return { returnCode, messageCount, messages, outputParameters };
  }

  /**
   * Parse one message from the reply buffer.
   *
   * @param {Buffer} buf
   * @param {number} offset
   * @param {number} datastreamLevel
   * @param {number} ccsid
   * @returns {{ message: AS400Message, nextOffset: number }|null}
   */
  static #parseOneMessage(buf, offset, datastreamLevel, ccsid) {
    if (offset + 6 > buf.length) return null;

    if (datastreamLevel >= 10) {
      return CommandRep.#parseNewFormatMessage(buf, offset, ccsid);
    }
    return CommandRep.#parseOldFormatMessage(buf, offset, ccsid);
  }

  /**
   * Parse old-format message (datastream < 10).
   *
   * Layout:
   *   +0-1:  LL (total message length)
   *   +2-5:  CP/header
   *   +6-12: Message ID (7 bytes, EBCDIC)
   *   +13-14: Message type (packed)
   *   +15-16: Severity (16-bit)
   *   +17-26: File name (10 bytes)
   *   +27-36: Library name (10 bytes)
   *   +37-38: Substitution data length
   *   +39-40: Text length
   *   +41+: Substitution data then text
   */
  static #parseOldFormatMessage(buf, offset, ccsid) {
    if (offset + 41 > buf.length) return null;

    const ll = buf.readUInt32BE(offset);
    if (ll < 41 || offset + ll > buf.length) return null;

    const conv = new CharConverter(ccsid);

    const msgId = conv.byteArrayToString(buf, offset + 6, 7).trim();
    const severity = buf.readUInt16BE(offset + 15);
    const subDataLen = buf.readUInt16BE(offset + 37);
    const textLen = buf.readUInt16BE(offset + 39);

    let substitutionData = null;
    let textOffset = offset + 41;

    if (subDataLen > 0 && textOffset + subDataLen <= offset + ll) {
      substitutionData = Buffer.alloc(subDataLen);
      buf.copy(substitutionData, 0, textOffset, textOffset + subDataLen);
      textOffset += subDataLen;
    }

    let text = '';
    if (textLen > 0 && textOffset + textLen <= offset + ll) {
      text = conv.byteArrayToString(buf, textOffset, textLen).trim();
    }

    const message = new AS400Message({
      id: msgId,
      text,
      severity,
      substitutionData,
    });

    return { message, nextOffset: offset + ll };
  }

  /**
   * Parse new-format message (datastream >= 10).
   *
   * Each field is: 4-byte length prefix + data.
   * Fields in order:
   *   severity, msgId, msgType, msgKey, fileName, fileLibSpec,
   *   fileLibUsed, sendJob, sendJobUser, sendJobNum, sendPgm,
   *   sendPgmInstr, dateSent, timeSent, recvPgm, recvPgmInstr,
   *   sendType, recvType, textCCSIDStatus, dataCCSIDStatus,
   *   alertOption, textCCSID, dataCCSID, substData, text, help
   */
  static #parseNewFormatMessage(buf, offset, defaultCcsid) {
    if (offset + 6 > buf.length) return null;

    const ll = buf.readUInt32BE(offset);
    if (ll < 6 || offset + ll > buf.length) return null;

    // Skip the first 6 bytes (LL + CP/flags)
    let pos = offset + 6;
    const end = offset + ll;

    const readField = () => {
      if (pos + 4 > end) return Buffer.alloc(0);
      const fieldLen = buf.readInt32BE(pos);
      pos += 4;
      if (fieldLen <= 0 || pos + fieldLen > end) {
        if (fieldLen > 0) pos = Math.min(pos + fieldLen, end);
        return Buffer.alloc(0);
      }
      const data = buf.subarray(pos, pos + fieldLen);
      pos += fieldLen;
      return data;
    };

    const readFieldAsInt = () => {
      const data = readField();
      if (data.length >= 4) return data.readInt32BE(0);
      return 0;
    };

    const severity = readFieldAsInt();
    const msgIdBuf = readField();
    const msgTypeBuf = readField();
    const msgKeyBuf = readField();
    const fileNameBuf = readField();
    const fileLibSpecBuf = readField();
    const fileLibUsedBuf = readField();
    readField(); // sendJob
    readField(); // sendJobUser
    readField(); // sendJobNum
    readField(); // sendPgm
    readField(); // sendPgmInstr
    readField(); // dateSent
    readField(); // timeSent
    readField(); // recvPgm
    readField(); // recvPgmInstr
    readField(); // sendType
    readField(); // recvType
    readFieldAsInt(); // textCCSIDStatus
    readFieldAsInt(); // dataCCSIDStatus
    readField(); // alertOption
    const textCCSID = readFieldAsInt();
    const dataCCSID = readFieldAsInt();
    const substDataBuf = readField();
    const textBuf = readField();
    const helpBuf = readField();

    const effectiveTextCcsid = textCCSID > 0 ? textCCSID : defaultCcsid;

    let msgId = '';
    if (msgIdBuf.length > 0) {
      try {
        msgId = new CharConverter(effectiveTextCcsid).byteArrayToString(msgIdBuf, 0, msgIdBuf.length).trim();
      } catch {
        msgId = msgIdBuf.toString('utf-8').trim();
      }
    }

    let text = '';
    if (textBuf.length > 0) {
      try {
        text = new CharConverter(effectiveTextCcsid).byteArrayToString(textBuf, 0, textBuf.length).trim();
      } catch {
        text = textBuf.toString('utf-8').trim();
      }
    }

    let helpText = '';
    if (helpBuf.length > 0) {
      try {
        helpText = new CharConverter(effectiveTextCcsid).byteArrayToString(helpBuf, 0, helpBuf.length).trim();
      } catch {
        helpText = helpBuf.toString('utf-8').trim();
      }
    }

    const substitutionData = substDataBuf.length > 0
      ? Buffer.from(substDataBuf)
      : null;

    const message = new AS400Message({
      id: msgId,
      text,
      severity,
      substitutionData,
      helpText: helpText || null,
    });

    return { message, nextOffset: offset + ll };
  }
}
