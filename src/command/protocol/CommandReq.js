/**
 * Command server request builders.
 *
 * Builds the datastreams for:
 *   - Exchange Attributes (0x1001)
 *   - Run Command        (0x1002)
 *   - Call Program        (0x1003)
 *
 * Upstream: RemoteCommandImplRemote.java,
 *           RCExchangeAttributesRequestDataStream.java,
 *           RCRunCommandRequestDataStream.java,
 *           RCCallProgramRequestDataStream.java
 * @module command/protocol/CommandReq
 */

import { ServerID } from '../../core/constants.js';
import { CharConverter } from '../../ccsid/CharConverter.js';

const CMD_SERVER_ID = ServerID.COMMAND; // 0xE008

/** Request/reply IDs. */
export const REQ_EXCHANGE_ATTRIBUTES = 0x1001;
export const REQ_RUN_COMMAND = 0x1002;
export const REQ_CALL_PROGRAM = 0x1003;

/** Code points. */
const CP_COMMAND_DATA = 0x1101;
const CP_COMMAND_DATA_CCSID = 0x1104;
const CP_PROGRAM_PARAMETER = 0x1103;

/** Message option constants. */
export const MSG_OPT_UP_TO_10 = 0;
export const MSG_OPT_NONE = 1;
export const MSG_OPT_ALL = 2;

/** Parameter usage flags on the wire. */
const USAGE_INPUT = 0x01;
const USAGE_OUTPUT = 0x02;
const USAGE_INOUT = 0x03;
const USAGE_NULL = 0xFF;

export class CommandReq {

  /**
   * Build an exchange-attributes request for the command server.
   *
   * @param {object} opts
   * @param {number} [opts.ccsid=0] - Client CCSID
   * @param {string} [opts.nlv='2924'] - National Language Version
   * @param {number} [opts.clientVersion=1]
   * @param {number} [opts.datastreamLevel=0]
   * @returns {Buffer}
   */
  static buildExchangeAttributes(opts = {}) {
    const {
      ccsid = 0,
      nlv = '2924',
      clientVersion = 1,
      datastreamLevel = 0,
    } = opts;

    // 20-byte header + 14-byte template
    const buf = Buffer.alloc(34);

    buf.writeUInt32BE(34, 0);                  // total length
    buf.writeUInt16BE(0, 4);                   // header ID
    buf.writeUInt16BE(CMD_SERVER_ID, 6);       // server ID
    buf.writeUInt32BE(0, 8);                   // CS instance
    buf.writeUInt32BE(0, 12);                  // correlation
    buf.writeUInt16BE(14, 16);                 // template length
    buf.writeUInt16BE(REQ_EXCHANGE_ATTRIBUTES, 18); // request ID

    // Template: CCSID (4) + NLV (4) + client version (4) + datastream level (2)
    buf.writeUInt32BE(ccsid, 20);

    // NLV: 4 chars encoded as (charCode | 0xF0)
    const nlvStr = nlv.padStart(4, '0');
    for (let i = 0; i < 4; i++) {
      buf[24 + i] = nlvStr.charCodeAt(i) | 0xF0;
    }

    buf.writeUInt32BE(clientVersion, 28);
    buf.writeUInt16BE(datastreamLevel, 32);

    return buf;
  }

  /**
   * Build a run-command request.
   *
   * @param {object} opts
   * @param {string} opts.command - CL command string
   * @param {number} [opts.datastreamLevel=10] - Negotiated datastream level
   * @param {number} [opts.ccsid=37] - CCSID for command text
   * @param {number} [opts.messageOption=MSG_OPT_ALL]
   * @returns {Buffer}
   */
  static buildRunCommand(opts) {
    const {
      command,
      datastreamLevel = 10,
      ccsid = 37,
      messageOption = MSG_OPT_ALL,
    } = opts;

    // Convert command text to the target CCSID
    const cmdBytes = CharConverter.stringToByteArray(command, ccsid);

    let totalLen;
    let templateLen;
    let cpType;

    if (datastreamLevel >= 10) {
      // New format: template=1, LL/CP with CCSID prefix
      templateLen = 1;
      cpType = CP_COMMAND_DATA_CCSID;
      // header(20) + template(1) + LL(4) + CP(2) + CCSID(4) + data
      totalLen = 20 + 1 + 4 + 2 + 4 + cmdBytes.length;
    } else {
      // Old format: template=1, LL/CP without CCSID
      templateLen = 1;
      cpType = CP_COMMAND_DATA;
      totalLen = 20 + 1 + 4 + 2 + cmdBytes.length;
    }

    const buf = Buffer.alloc(totalLen);

    // Header
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(CMD_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_RUN_COMMAND, 18);

    // Template: message option
    const msgOpt = CommandReq.#resolveMessageOption(messageOption, datastreamLevel);
    buf[20] = msgOpt;

    let offset = 20 + templateLen;

    if (datastreamLevel >= 10) {
      const ll = 4 + 2 + 4 + cmdBytes.length;
      buf.writeUInt32BE(ll, offset);
      buf.writeUInt16BE(cpType, offset + 4);
      buf.writeUInt32BE(ccsid, offset + 6);
      cmdBytes.copy(buf, offset + 10);
    } else {
      const ll = 4 + 2 + cmdBytes.length;
      buf.writeUInt32BE(ll, offset);
      buf.writeUInt16BE(cpType, offset + 4);
      cmdBytes.copy(buf, offset + 6);
    }

    return buf;
  }

  /**
   * Build a call-program request.
   *
   * @param {object} opts
   * @param {string} opts.programPath - IFS path like "/QSYS.LIB/MYLIB.LIB/MYPGM.PGM"
   * @param {import('../ProgramParameter.js').ProgramParameter[]} opts.parameters
   * @param {number} [opts.datastreamLevel=10]
   * @param {number} [opts.ccsid=37] - CCSID for program/library names
   * @param {number} [opts.messageOption=MSG_OPT_ALL]
   * @returns {Buffer}
   */
  static buildCallProgram(opts) {
    const {
      programPath,
      parameters = [],
      datastreamLevel = 10,
      ccsid = 37,
      messageOption = MSG_OPT_ALL,
    } = opts;

    const { programName, libraryName } = CommandReq.#parseProgramPath(programPath);

    // Encode names to EBCDIC (10 bytes each, blank-padded)
    const conv = new CharConverter(ccsid);
    const pgmEbcdic = CommandReq.#padEbcdic(conv, programName, 10);
    const libEbcdic = CommandReq.#padEbcdic(conv, libraryName, 10);

    // Template: program(10) + library(10) + msgOption(1) + paramCount(2) = 23
    const templateLen = 23;

    // Calculate parameter blocks
    let paramBlockSize = 0;
    for (const p of parameters) {
      // LL(4) + CP(2) + maxLen(4) + usage(2) + data(variable)
      const dataLen = p.getInputLength();
      const maxOut = p.getMaxOutputSize();
      const maxLen = Math.max(dataLen, maxOut);
      paramBlockSize += 12 + dataLen;
    }

    const totalLen = 20 + templateLen + paramBlockSize;
    const buf = Buffer.alloc(totalLen);

    // Header
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(CMD_SERVER_ID, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(REQ_CALL_PROGRAM, 18);

    // Template
    let offset = 20;
    pgmEbcdic.copy(buf, offset);
    offset += 10;
    libEbcdic.copy(buf, offset);
    offset += 10;

    const msgOpt = CommandReq.#resolveMessageOption(messageOption, datastreamLevel);
    buf[offset] = msgOpt;
    offset += 1;

    buf.writeUInt16BE(parameters.length, offset);
    offset += 2;

    // Parameter blocks
    for (const p of parameters) {
      const isNull = p.isNullParameter();
      const dataLen = p.getInputLength();
      const maxOut = p.getMaxOutputSize();
      const maxLen = Math.max(dataLen, maxOut);

      const ll = 12 + dataLen;
      buf.writeUInt32BE(ll, offset);
      buf.writeUInt16BE(CP_PROGRAM_PARAMETER, offset + 4);
      buf.writeUInt32BE(maxLen, offset + 6);

      let usageFlag;
      if (isNull) {
        usageFlag = USAGE_NULL;
      } else {
        const u = p.getUsage();
        if (u === 1) usageFlag = USAGE_INPUT;
        else if (u === 2) usageFlag = USAGE_OUTPUT;
        else usageFlag = USAGE_INOUT;
      }
      buf.writeUInt16BE(usageFlag, offset + 10);

      if (dataLen > 0) {
        p.getInputData().copy(buf, offset + 12, 0, dataLen);
      }

      offset += ll;
    }

    return buf;
  }

  /**
   * Parse an IFS program path into program name and library name.
   *
   * Supports:
   *   /QSYS.LIB/MYLIB.LIB/MYPGM.PGM
   *   /QSYS.LIB/MYPGM.PGM  (library = *LIBL)
   *   MYLIB/MYPGM
   *
   * @param {string} path
   * @returns {{ programName: string, libraryName: string }}
   */
  static #parseProgramPath(path) {
    const normalized = path.trim().toUpperCase();

    // IFS-style: /QSYS.LIB/...
    if (normalized.startsWith('/')) {
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length >= 3) {
        // /QSYS.LIB/MYLIB.LIB/MYPGM.PGM
        const lib = parts[1].replace(/\.LIB$/i, '');
        const pgm = parts[2].replace(/\.(PGM|SRVPGM)$/i, '');
        return { programName: pgm, libraryName: lib };
      }
      if (parts.length === 2) {
        // /QSYS.LIB/MYPGM.PGM
        const pgm = parts[1].replace(/\.(PGM|SRVPGM)$/i, '');
        return { programName: pgm, libraryName: '*LIBL' };
      }
    }

    // Library/program style
    if (normalized.includes('/')) {
      const [lib, pgm] = normalized.split('/');
      return {
        programName: pgm.replace(/\.(PGM|SRVPGM)$/i, ''),
        libraryName: lib || '*LIBL',
      };
    }

    return { programName: normalized.replace(/\.(PGM|SRVPGM)$/i, ''), libraryName: '*LIBL' };
  }

  /**
   * Pad a string to a fixed-length EBCDIC buffer with blank (0x40) padding.
   */
  static #padEbcdic(conv, str, len) {
    const buf = Buffer.alloc(len, 0x40);
    const encoded = conv.stringToByteArray(str);
    encoded.copy(buf, 0, 0, Math.min(encoded.length, len));
    return buf;
  }

  /**
   * Resolve message option byte for the wire format.
   */
  static #resolveMessageOption(option, datastreamLevel) {
    if (datastreamLevel >= 11) {
      if (option === MSG_OPT_UP_TO_10) return 5;
      if (option === MSG_OPT_ALL) return 6;
      return option;
    }
    if (datastreamLevel >= 10) {
      if (option === MSG_OPT_UP_TO_10) return 3;
      if (option === MSG_OPT_ALL) return 4;
      return option;
    }
    return option;
  }
}
