/**
 * Output queue management.
 *
 * Lists spooled files in an output queue and manages queue properties.
 * Uses CL commands and program calls for operations.
 *
 * Upstream: OutputQueue.java, OutputQueueList.java
 * @module print/OutputQueue
 */

import { PrintError } from '../core/errors.js';
import { QSYSObjectPathName } from '../ifs/QSYSObjectPathName.js';
import { SpooledFile } from './SpooledFile.js';

export class OutputQueue {
  #system;
  #path;
  #library;
  #name;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - IFS path like /QSYS.LIB/QUSRSYS.LIB/MYOUTQ.OUTQ
   */
  constructor(system, path) {
    if (!system) throw new Error('OutputQueue requires an AS400 instance');
    if (!path) throw new Error('OutputQueue requires a path');
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
   * List spooled files in this output queue.
   * Uses QGYOLSPL API (Open List of Spooled Files).
   *
   * @returns {Promise<SpooledFile[]>}
   */
  async listSpooledFiles() {
    const { ProgramCall } = await import('../command/ProgramCall.js');
    const { ProgramParameter } = await import('../command/ProgramParameter.js');
    const { CharConverter } = await import('../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    const outLen = 65536;

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(outLen, 0);

    const listInfoLen = 80;
    const numRecords = Buffer.alloc(4);
    numRecords.writeInt32BE(-1, 0);

    const sortInfo = Buffer.alloc(4);
    sortInfo.writeInt32BE(0, 0);

    // Filter structure for QGYOLSPL
    const filterLen = 54;
    const filter = Buffer.alloc(filterLen, 0x40);
    filter.writeInt32BE(1, 0);
    conv.stringToByteArray('*ALL').copy(filter, 4, 0, 4);
    conv.stringToByteArray(this.#name.toUpperCase()).copy(filter, 14, 0, 10);
    conv.stringToByteArray(this.#library.toUpperCase()).copy(filter, 24, 0, 10);
    conv.stringToByteArray('*ALL').copy(filter, 34, 0, 4);
    conv.stringToByteArray('*ALL').copy(filter, 44, 0, 4);

    const qualJobName = Buffer.alloc(26, 0x40);
    conv.stringToByteArray('*ALL').copy(qualJobName, 0, 0, 4);

    const formatBuf = Buffer.alloc(8, 0x40);
    conv.stringToByteArray('OSPL0100').copy(formatBuf, 0, 0, 8);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QGY.LIB/QGYOLSPL.PGM', [
      new ProgramParameter({ outputLength: outLen }),
      new ProgramParameter({ inputData: lenBuf }),
      new ProgramParameter({ outputLength: listInfoLen }),
      new ProgramParameter({ inputData: numRecords }),
      new ProgramParameter({ inputData: sortInfo }),
      new ProgramParameter({ inputData: filter }),
      new ProgramParameter({ inputData: qualJobName }),
      new ProgramParameter({ inputData: formatBuf }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const spooledFiles = [];

    try {
      const success = await pc.run();
      if (success) {
        const outBuf = pc.getParameterList()[0].getOutputData();
        const listBuf = pc.getParameterList()[2].getOutputData();

        if (listBuf && listBuf.length >= 16) {
          const recordsReturned = listBuf.readInt32BE(4);
          const recordLength = listBuf.readInt32BE(12);

          for (let i = 0; i < recordsReturned && outBuf; i++) {
            const recOffset = i * recordLength;
            if (recOffset + 90 > outBuf.length) break;

            const splName = conv.byteArrayToString(outBuf, recOffset, 10).trim();
            const jobName = conv.byteArrayToString(outBuf, recOffset + 10, 10).trim();
            const jobUser = conv.byteArrayToString(outBuf, recOffset + 20, 10).trim();
            const jobNumber = conv.byteArrayToString(outBuf, recOffset + 30, 6).trim();
            const splNumber = outBuf.readInt32BE(recOffset + 36);
            const totalPages = outBuf.readInt32BE(recOffset + 40);

            const sf = new SpooledFile(this.#system, splName, {
              jobName,
              jobUser,
              jobNumber,
              spooledFileNumber: splNumber,
              totalPages,
              outputQueue: this.#name,
              outputQueueLibrary: this.#library,
            });

            spooledFiles.push(sf);
          }
        }
      }
    } catch {
      // If the API call fails, return empty
    }

    return spooledFiles;
  }

  /**
   * Clear the output queue.
   * @returns {Promise<void>}
   */
  async clear() {
    const cmd = `CLROUTQ OUTQ(${this.#library}/${this.#name})`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new PrintError(
        `OutputQueue clear failed: ${errMsg.text}`,
        { messageId: errMsg.id },
      );
    }
  }

  /**
   * Hold the output queue.
   * @returns {Promise<void>}
   */
  async hold() {
    const cmd = `HLDOUTQ OUTQ(${this.#library}/${this.#name})`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new PrintError(
        `OutputQueue hold failed: ${errMsg.text}`,
        { messageId: errMsg.id },
      );
    }
  }

  /**
   * Release the output queue.
   * @returns {Promise<void>}
   */
  async release() {
    const cmd = `RLSOUTQ OUTQ(${this.#library}/${this.#name})`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new PrintError(
        `OutputQueue release failed: ${errMsg.text}`,
        { messageId: errMsg.id },
      );
    }
  }
}
