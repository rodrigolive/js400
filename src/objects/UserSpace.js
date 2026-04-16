/**
 * User space create/read/write/resize/delete API.
 *
 * Uses QUSCRTUS, QUSRTVUS, QUSCHGUS, QUSDLTUS IBM i APIs
 * via program calls.
 *
 * Upstream: UserSpace.java
 * @module objects/UserSpace
 */

import { QSYSObjectPathName } from '../ifs/QSYSObjectPathName.js';
import { AS400Error } from '../core/errors.js';

export class UserSpace {
  #system;
  #path;
  #library;
  #name;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - IFS path like /QSYS.LIB/QTEMP.LIB/MYSPACE.USRSPC
   */
  constructor(system, path) {
    if (!system) throw new Error('UserSpace requires an AS400 instance');
    if (!path) throw new Error('UserSpace requires a path');
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
   * Create the user space.
   * Uses QUSCRTUS API.
   *
   * @param {object} [opts]
   * @param {number} [opts.size=1024]
   * @param {number} [opts.initialValue=0x00]
   * @param {string} [opts.authority='*ALL']
   * @param {string} [opts.description='']
   * @param {string} [opts.extendedAttribute='']
   * @param {boolean} [opts.replace=false]
   * @returns {Promise<void>}
   */
  async create(opts = {}) {
    const { ProgramCall } = await import('../command/ProgramCall.js');
    const { ProgramParameter } = await import('../command/ProgramParameter.js');
    const { CharConverter } = await import('../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    // QUSCRTUS parameters:
    //  1. Qualified user space name (input, char20)
    //  2. Extended attribute (input, char10)
    //  3. Initial size (input, bin4)
    //  4. Initial value (input, char1)
    //  5. Public authority (input, char10)
    //  6. Text description (input, char50)
    //  7. Replace (input, char10) - *YES or *NO
    //  8. Error code (input/output)

    const qualName = Buffer.alloc(20, 0x40);
    conv.stringToByteArray(this.#name.toUpperCase()).copy(qualName, 0, 0, 10);
    conv.stringToByteArray(this.#library.toUpperCase()).copy(qualName, 10, 0, 10);

    const extAttr = Buffer.alloc(10, 0x40);
    if (opts.extendedAttribute) {
      conv.stringToByteArray(opts.extendedAttribute.toUpperCase()).copy(extAttr, 0, 0, 10);
    }

    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeInt32BE(opts.size ?? 1024, 0);

    const initVal = Buffer.alloc(1);
    initVal[0] = opts.initialValue ?? 0x00;

    const authority = Buffer.alloc(10, 0x40);
    conv.stringToByteArray(opts.authority ?? '*ALL').copy(authority, 0, 0, 10);

    const descStr = (opts.description ?? '').padEnd(50, ' ').substring(0, 50);
    const description = Buffer.alloc(50, 0x40);
    conv.stringToByteArray(descStr).copy(description, 0, 0, 50);

    const replace = Buffer.alloc(10, 0x40);
    conv.stringToByteArray(opts.replace ? '*YES' : '*NO').copy(replace, 0, 0, 10);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QUSCRTUS.PGM', [
      new ProgramParameter({ inputData: qualName }),
      new ProgramParameter({ inputData: extAttr }),
      new ProgramParameter({ inputData: sizeBuf }),
      new ProgramParameter({ inputData: initVal }),
      new ProgramParameter({ inputData: authority }),
      new ProgramParameter({ inputData: description }),
      new ProgramParameter({ inputData: replace }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const success = await pc.run();
    if (!success) {
      const msgs = pc.getMessageList();
      throw new AS400Error(
        `UserSpace create failed: ${msgs[0]?.text ?? 'unknown error'}`,
        { messageId: msgs[0]?.id, hostService: 'COMMAND' },
      );
    }
  }

  /**
   * Read data from the user space.
   * Uses QUSRTVUS API.
   *
   * @param {number} offset - Starting position (0-based)
   * @param {number} length - Number of bytes to read
   * @returns {Promise<Buffer>}
   */
  async read(offset, length) {
    const { ProgramCall } = await import('../command/ProgramCall.js');
    const { ProgramParameter } = await import('../command/ProgramParameter.js');
    const { CharConverter } = await import('../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    // QUSRTVUS parameters:
    //  1. Qualified user space name (input, char20)
    //  2. Starting position (input, bin4) - 1-based
    //  3. Length of data (input, bin4)
    //  4. Receiver variable (output)
    //  5. Error code (input/output)

    const qualName = Buffer.alloc(20, 0x40);
    conv.stringToByteArray(this.#name.toUpperCase()).copy(qualName, 0, 0, 10);
    conv.stringToByteArray(this.#library.toUpperCase()).copy(qualName, 10, 0, 10);

    const startPos = Buffer.alloc(4);
    startPos.writeInt32BE(offset + 1, 0); // 1-based

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(length, 0);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QUSRTVUS.PGM', [
      new ProgramParameter({ inputData: qualName }),
      new ProgramParameter({ inputData: startPos }),
      new ProgramParameter({ inputData: lenBuf }),
      new ProgramParameter({ outputLength: length }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const success = await pc.run();
    if (!success) {
      const msgs = pc.getMessageList();
      throw new AS400Error(
        `UserSpace read failed: ${msgs[0]?.text ?? 'unknown error'}`,
        { messageId: msgs[0]?.id, hostService: 'COMMAND' },
      );
    }

    return pc.getParameterList()[3].getOutputData() ?? Buffer.alloc(0);
  }

  /**
   * Write data to the user space.
   * Uses QUSCHGUS API.
   *
   * @param {number} offset - Starting position (0-based)
   * @param {Buffer|Uint8Array} data
   * @returns {Promise<void>}
   */
  async write(offset, data) {
    const { ProgramCall } = await import('../command/ProgramCall.js');
    const { ProgramParameter } = await import('../command/ProgramParameter.js');
    const { CharConverter } = await import('../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    // QUSCHGUS parameters:
    //  1. Qualified user space name (input, char20)
    //  2. Starting position (input, bin4) - 1-based
    //  3. Length of data (input, bin4)
    //  4. Input data (input, variable)
    //  5. Force changes to auxiliary storage (input, char1) - '0'=no, '1'=yes
    //  6. Error code (input/output)

    const qualName = Buffer.alloc(20, 0x40);
    conv.stringToByteArray(this.#name.toUpperCase()).copy(qualName, 0, 0, 10);
    conv.stringToByteArray(this.#library.toUpperCase()).copy(qualName, 10, 0, 10);

    const startPos = Buffer.alloc(4);
    startPos.writeInt32BE(offset + 1, 0); // 1-based

    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(dataBuf.length, 0);

    const force = Buffer.alloc(1);
    force[0] = 0xF0; // '0' in EBCDIC = no force

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QUSCHGUS.PGM', [
      new ProgramParameter({ inputData: qualName }),
      new ProgramParameter({ inputData: startPos }),
      new ProgramParameter({ inputData: lenBuf }),
      new ProgramParameter({ inputData: dataBuf }),
      new ProgramParameter({ inputData: force }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const success = await pc.run();
    if (!success) {
      const msgs = pc.getMessageList();
      throw new AS400Error(
        `UserSpace write failed: ${msgs[0]?.text ?? 'unknown error'}`,
        { messageId: msgs[0]?.id, hostService: 'COMMAND' },
      );
    }
  }

  /**
   * Set the length (resize) of the user space.
   * Uses QUSCHGUS via CL command CHGUSRSPC.
   *
   * @param {number} newLength
   * @returns {Promise<void>}
   */
  async setLength(newLength) {
    const cmd = `CHGUSRSPC USRSPC(${this.#library}/${this.#name}) SIZE(${newLength})`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new AS400Error(
        `UserSpace resize failed: ${errMsg.text}`,
        { messageId: errMsg.id, hostService: 'COMMAND' },
      );
    }
  }

  /**
   * Delete the user space.
   * Uses QUSDLTUS API.
   *
   * @returns {Promise<void>}
   */
  async delete() {
    const { ProgramCall } = await import('../command/ProgramCall.js');
    const { ProgramParameter } = await import('../command/ProgramParameter.js');
    const { CharConverter } = await import('../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    const qualName = Buffer.alloc(20, 0x40);
    conv.stringToByteArray(this.#name.toUpperCase()).copy(qualName, 0, 0, 10);
    conv.stringToByteArray(this.#library.toUpperCase()).copy(qualName, 10, 0, 10);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QUSDLTUS.PGM', [
      new ProgramParameter({ inputData: qualName }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const success = await pc.run();
    if (!success) {
      const msgs = pc.getMessageList();
      throw new AS400Error(
        `UserSpace delete failed: ${msgs[0]?.text ?? 'unknown error'}`,
        { messageId: msgs[0]?.id, hostService: 'COMMAND' },
      );
    }
  }
}
