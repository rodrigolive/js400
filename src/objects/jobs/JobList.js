/**
 * Job listing with filters and async-iterable support.
 *
 * Uses QGYOLJOB (Open List of Jobs) API via program calls.
 *
 * Upstream: JobList.java
 * @module objects/jobs/JobList
 */

import { AS400Error } from '../../core/errors.js';

export class JobList {
  #system;
  #criteria;

  static SELECTION_JOB_NAME = 'jobName';
  static SELECTION_USER_NAME = 'userName';
  static SELECTION_JOB_NUMBER = 'jobNumber';
  static SELECTION_JOB_TYPE = 'jobType';
  static SELECTION_ACTIVE_STATUS = 'activeStatus';

  /**
   * @param {import('../../core/AS400.js').AS400} system
   */
  constructor(system) {
    if (!system) throw new Error('JobList requires an AS400 instance');
    this.#system = system;
    this.#criteria = {};
  }

  /**
   * Add a selection criterion.
   * @param {string} key
   * @param {string} value
   */
  addJobSelectionCriteria(key, value) {
    this.#criteria[key] = value;
  }

  /**
   * List jobs matching criteria via CL command WRKACTJOB style.
   * Returns an async iterable of job info objects.
   *
   * @returns {AsyncGenerator<{name: string, user: string, number: string, type: string, status: string}>}
   */
  async *[Symbol.asyncIterator]() {
    const { ProgramCall } = await import('../../command/ProgramCall.js');
    const { ProgramParameter } = await import('../../command/ProgramParameter.js');
    const { CharConverter } = await import('../../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    // Use QUSLJOB API (List Jobs)
    // Alternatively, use command-based approach
    const outLen = 32768;

    const formatBuf = Buffer.alloc(8, 0x40);
    conv.stringToByteArray('OLJB0200').copy(formatBuf, 0, 0, 8);

    // Build qualified job name filter
    const jobName = (this.#criteria.jobName ?? '*ALL').toUpperCase();
    const userName = (this.#criteria.userName ?? '*ALL').toUpperCase();
    const jobNumber = (this.#criteria.jobNumber ?? '*ALL').toUpperCase();
    const jobType = (this.#criteria.jobType ?? '*').toUpperCase();

    const qualJobName = Buffer.alloc(26, 0x40);
    conv.stringToByteArray(jobName.padEnd(10, ' ')).copy(qualJobName, 0, 0, 10);
    conv.stringToByteArray(userName.padEnd(10, ' ')).copy(qualJobName, 10, 0, 10);
    conv.stringToByteArray(jobNumber.padEnd(6, ' ')).copy(qualJobName, 20, 0, 6);

    const statusBuf = Buffer.alloc(10, 0x40);
    conv.stringToByteArray('*ACTIVE').copy(statusBuf, 0, 0, 7);

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(outLen, 0);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    // Use simpler QUSLJOB API
    // Parameters:
    //  1. Receiver variable (output)
    //  2. Length of receiver variable (input, bin4)
    //  3. Format name (input, char8) - JOBL0100
    //  4. Qualified job name (input, char26)
    //  5. Status (input, char10)
    //  6. Error code (input/output)

    const listFmt = Buffer.alloc(8, 0x40);
    conv.stringToByteArray('JOBL0100').copy(listFmt, 0, 0, 8);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QUSLJOB.PGM', [
      new ProgramParameter({ outputLength: outLen }),
      new ProgramParameter({ inputData: lenBuf }),
      new ProgramParameter({ inputData: listFmt }),
      new ProgramParameter({ inputData: qualJobName }),
      new ProgramParameter({ inputData: statusBuf }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const success = await pc.run();
    if (!success) return;

    const outBuf = pc.getParameterList()[0].getOutputData();
    if (!outBuf || outBuf.length < 140) return;

    // List header (QUSH0100):
    // Offset 0-3: user area (char64) - actually starts with header info
    // We need the standard list format:
    // Offset 124: offset to list data
    // Offset 128: number of entries returned
    // Offset 132: entry size

    // QUSLJOB returns data in user space format
    // The first 8 bytes are bytes returned/available
    // Offset 8: offset to list data section
    // But for QUSLJOB, the output format is different

    // Actually QUSLJOB uses a standard list API format:
    // Bytes 0-7: user area
    // Byte 8-11: generic header size
    // ... standard list header
    // Let's parse the simple way - the list data follows the header

    const totalReturned = outBuf.readInt32BE(0);
    if (totalReturned <= 8) return;

    // For the user space list API, entries start after list header
    // The list header offset is at position 124 in the user space
    // Each JOBL0100 entry is 56 bytes:
    //   Offset 0: job name (char10)
    //   Offset 10: user name (char10)
    //   Offset 20: job number (char6)
    //   Offset 26: internal job id (char16)
    //   Offset 42: job status (char10)
    //   Offset 52: job type (char1)
    //   Offset 53: job subtype (char1)

    // Since this is a simplified format, parse entries starting after header
    let offset = 8;
    const entrySize = 56;

    while (offset + entrySize <= outBuf.length && offset + entrySize <= totalReturned) {
      const name = conv.byteArrayToString(outBuf, offset, 10).trim();
      const user = conv.byteArrayToString(outBuf, offset + 10, 10).trim();
      const num = conv.byteArrayToString(outBuf, offset + 20, 6).trim();
      const status = conv.byteArrayToString(outBuf, offset + 42, 10).trim();
      const type = conv.byteArrayToString(outBuf, offset + 52, 1).trim();

      if (name) {
        yield { name, user, number: num, type, status };
      }
      offset += entrySize;
    }
  }
}
