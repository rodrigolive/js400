/**
 * Data area read/write API.
 *
 * Supports Character, Decimal, and Logical data areas via QWCRDTAA
 * (Retrieve Data Area) and QWCCHGDA (Change Data Area) APIs.
 *
 * Upstream: *DataArea*.java
 * @module objects/system/DataArea
 */

import { AS400Error } from '../../core/errors.js';
import { QSYSObjectPathName } from '../../ifs/QSYSObjectPathName.js';

export class DataArea {
  #system;
  #path;
  #library;
  #name;

  /**
   * @param {import('../../core/AS400.js').AS400} system
   * @param {string} path - IFS path like /QSYS.LIB/MYLIB.LIB/MYDA.DTAARA
   */
  constructor(system, path) {
    if (!system) throw new Error('DataArea requires an AS400 instance');
    if (!path) throw new Error('DataArea requires a path');
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
   * Read the data area contents as a string.
   * Uses QWCRDTAA API.
   *
   * @param {number} [offset=0] - Starting position (0-based)
   * @param {number} [length=-1] - Number of characters to read (-1 = all)
   * @returns {Promise<string>}
   */
  async readCharacter(offset = 0, length = -1) {
    const { ProgramCall } = await import('../../command/ProgramCall.js');
    const { ProgramParameter } = await import('../../command/ProgramParameter.js');
    const { CharConverter } = await import('../../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    // QWCRDTAA parameters:
    //  1. Receiver variable (output)
    //  2. Length of receiver variable (input, bin4)
    //  3. Qualified data area name (input, char20)
    //  4. Starting position (input, bin4) - 1-based, -1 = all
    //  5. Length of data (input, bin4) - -1 = all
    //  6. Error code (input/output)

    const outLen = 4096;
    const qualName = Buffer.alloc(20, 0x40);
    conv.stringToByteArray(this.#name.toUpperCase()).copy(qualName, 0, 0, 10);
    conv.stringToByteArray(this.#library.toUpperCase()).copy(qualName, 10, 0, 10);

    const startPos = Buffer.alloc(4);
    startPos.writeInt32BE(length === -1 ? -1 : offset + 1, 0);

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(length === -1 ? -1 : length, 0);

    const outLenBuf = Buffer.alloc(4);
    outLenBuf.writeInt32BE(outLen, 0);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QWCRDTAA.PGM', [
      new ProgramParameter({ outputLength: outLen }),
      new ProgramParameter({ inputData: outLenBuf }),
      new ProgramParameter({ inputData: qualName }),
      new ProgramParameter({ inputData: startPos }),
      new ProgramParameter({ inputData: lenBuf }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const success = await pc.run();
    if (!success) {
      const msgs = pc.getMessageList();
      throw new AS400Error(
        `DataArea read failed: ${msgs[0]?.text ?? 'unknown error'}`,
        { messageId: msgs[0]?.id, hostService: 'COMMAND' },
      );
    }

    const outBuf = pc.getParameterList()[0].getOutputData();
    if (outBuf && outBuf.length >= 36) {
      // Output format:
      // Offset 0: bytes available (bin4)
      // Offset 4: bytes returned (bin4)
      // Offset 8: type of value returned (char1) - 'C'=char, 'D'=decimal, 'L'=logical
      // Offset 9: library name (char10)
      // Offset 19: length of value returned (bin4)
      // Offset 23: number of decimal positions (bin4)
      // Offset 27: value (variable)
      const dataType = conv.byteArrayToString(outBuf, 8, 1);
      const dataLen = outBuf.readInt32BE(19);

      if (dataLen > 0 && 36 + dataLen <= outBuf.length) {
        if (dataType === 'C') {
          return conv.byteArrayToString(outBuf, 36, dataLen).trim();
        }
        return conv.byteArrayToString(outBuf, 36, dataLen).trim();
      }
    }

    return '';
  }

  /**
   * Read the data area as a decimal value.
   * @returns {Promise<number>}
   */
  async readDecimal() {
    const strVal = await this.readCharacter();
    return parseFloat(strVal) || 0;
  }

  /**
   * Read the data area as a logical (boolean) value.
   * @returns {Promise<boolean>}
   */
  async readLogical() {
    const strVal = await this.readCharacter();
    return strVal === '1' || strVal.toUpperCase() === 'TRUE';
  }

  /**
   * Write a character value to the data area.
   * Uses CL command CHGDTAARA.
   *
   * @param {string} value
   * @param {number} [offset=0]
   * @returns {Promise<void>}
   */
  async writeCharacter(value, offset = 0) {
    const safeValue = value.replace(/'/g, "''");
    let cmd;
    if (offset === 0) {
      cmd = `CHGDTAARA DTAARA(${this.#library}/${this.#name}) VALUE('${safeValue}')`;
    } else {
      cmd = `CHGDTAARA DTAARA(${this.#library}/${this.#name} (${offset + 1} ${value.length})) VALUE('${safeValue}')`;
    }

    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new AS400Error(
        `DataArea write failed: ${errMsg.text}`,
        { messageId: errMsg.id, hostService: 'COMMAND' },
      );
    }
  }

  /**
   * Write a decimal value to the data area.
   * @param {number} value
   * @returns {Promise<void>}
   */
  async writeDecimal(value) {
    const cmd = `CHGDTAARA DTAARA(${this.#library}/${this.#name}) VALUE(${value})`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new AS400Error(
        `DataArea writeDecimal failed: ${errMsg.text}`,
        { messageId: errMsg.id, hostService: 'COMMAND' },
      );
    }
  }

  /**
   * Write a logical value to the data area.
   * @param {boolean} value
   * @returns {Promise<void>}
   */
  async writeLogical(value) {
    const cmd = `CHGDTAARA DTAARA(${this.#library}/${this.#name}) VALUE('${value ? '1' : '0'}')`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new AS400Error(
        `DataArea writeLogical failed: ${errMsg.text}`,
        { messageId: errMsg.id, hostService: 'COMMAND' },
      );
    }
  }

  /**
   * Create the data area.
   * @param {object} [opts]
   * @param {string} [opts.type='*CHAR'] - *CHAR, *DEC, *LGL
   * @param {number} [opts.length=100]
   * @param {string} [opts.description='']
   * @returns {Promise<void>}
   */
  async create(opts = {}) {
    const type = opts.type ?? '*CHAR';
    const len = opts.length ?? 100;
    const desc = opts.description ?? '';
    const safeDesc = desc.replace(/'/g, "''");

    const cmd = `CRTDTAARA DTAARA(${this.#library}/${this.#name}) TYPE(${type})` +
      ` LEN(${len})` +
      (safeDesc ? ` TEXT('${safeDesc}')` : '');

    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new AS400Error(
        `DataArea create failed: ${errMsg.text}`,
        { messageId: errMsg.id, hostService: 'COMMAND' },
      );
    }
  }

  /**
   * Delete the data area.
   * @returns {Promise<void>}
   */
  async delete() {
    const cmd = `DLTDTAARA DTAARA(${this.#library}/${this.#name})`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new AS400Error(
        `DataArea delete failed: ${errMsg.text}`,
        { messageId: errMsg.id, hostService: 'COMMAND' },
      );
    }
  }
}
