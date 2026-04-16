/**
 * System status and pool information.
 *
 * Uses QWCRSSTS (Retrieve System Status) API via program calls.
 *
 * Upstream: SystemStatus.java, SystemPool.java
 * @module objects/system/SystemStatus
 */

import { AS400Error } from '../../core/errors.js';

export class SystemStatus {
  #system;
  #info;
  #loaded;

  /**
   * @param {import('../../core/AS400.js').AS400} system
   */
  constructor(system) {
    if (!system) throw new Error('SystemStatus requires an AS400 instance');
    this.#system = system;
    this.#info = {};
    this.#loaded = false;
  }

  getSystemName() { return this.#info.systemName ?? ''; }
  getCurrentDateTime() { return this.#info.currentDateTime ?? ''; }
  getUsersCurrentSignedOn() { return this.#info.usersCurrentSignedOn ?? 0; }
  getUsersTemporarilySignedOff() { return this.#info.usersTemporarilySignedOff ?? 0; }
  getUsersSuspendedByGroupJobs() { return this.#info.usersSuspendedByGroupJobs ?? 0; }
  getUsersSuspendedBySystemRequest() { return this.#info.usersSuspendedBySystemRequest ?? 0; }
  getUsersSignedOffWithPrinterOutput() { return this.#info.usersSignedOffWithPrinterOutput ?? 0; }
  getBatchJobsRunning() { return this.#info.batchJobsRunning ?? 0; }
  getBatchJobsWaiting() { return this.#info.batchJobsWaiting ?? 0; }
  getBatchJobsHeldOnJobQueue() { return this.#info.batchJobsHeldOnJobQueue ?? 0; }
  getBatchJobsEnding() { return this.#info.batchJobsEnding ?? 0; }
  getPercentSystemASPUsed() { return this.#info.percentSystemASPUsed ?? 0; }
  getTotalAuxiliaryStorage() { return this.#info.totalAuxiliaryStorage ?? 0; }
  getSystemASP() { return this.#info.systemASP ?? 0; }
  getPercentProcessingUnitUsed() { return this.#info.percentProcessingUnitUsed ?? 0; }
  getJobsInSystem() { return this.#info.jobsInSystem ?? 0; }
  getPercentPermanentAddresses() { return this.#info.percentPermanentAddresses ?? 0; }
  getPercentTemporaryAddresses() { return this.#info.percentTemporaryAddresses ?? 0; }
  getNumberOfProcessors() { return this.#info.numberOfProcessors ?? 0; }
  getActiveJobsInSystem() { return this.#info.activeJobsInSystem ?? 0; }
  getInfo() { return { ...this.#info }; }

  /**
   * Load system status from the host.
   * Uses QWCRSSTS API with format SSTS0200.
   *
   * @returns {Promise<void>}
   */
  async load() {
    const { ProgramCall } = await import('../../command/ProgramCall.js');
    const { ProgramParameter } = await import('../../command/ProgramParameter.js');
    const { CharConverter } = await import('../../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    const outLen = 4096;

    // QWCRSSTS parameters:
    //  1. Receiver variable (output)
    //  2. Length of receiver variable (input, bin4)
    //  3. Format name (input, char8)
    //  4. Reset status statistics (input, char10) - *NO
    //  5. Error code (input/output)

    const formatBuf = Buffer.alloc(8, 0x40);
    conv.stringToByteArray('SSTS0200').copy(formatBuf, 0, 0, 8);

    const resetStats = Buffer.alloc(10, 0x40);
    conv.stringToByteArray('*NO').copy(resetStats, 0, 0, 3);

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(outLen, 0);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QWCRSSTS.PGM', [
      new ProgramParameter({ outputLength: outLen }),
      new ProgramParameter({ inputData: lenBuf }),
      new ProgramParameter({ inputData: formatBuf }),
      new ProgramParameter({ inputData: resetStats }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const success = await pc.run();
    if (!success) {
      const msgs = pc.getMessageList();
      throw new AS400Error(
        `SystemStatus load failed: ${msgs[0]?.text ?? 'unknown error'}`,
        { messageId: msgs[0]?.id, hostService: 'COMMAND' },
      );
    }

    const outBuf = pc.getParameterList()[0].getOutputData();
    if (outBuf && outBuf.length >= 80) {
      // SSTS0200 format:
      // Offset 0: bytes available (bin4)
      // Offset 4: bytes returned (bin4)
      // Offset 8: current date and time (char8)
      // Offset 16: system name (char8)
      // Offset 24: users currently signed on (bin4)
      // Offset 28: users temporarily signed off (bin4)
      // Offset 32: users suspended by group jobs (bin4)
      // Offset 36: users suspended by system request (bin4)
      // Offset 40: users signed off with printer output (bin4)
      // Offset 44: batch jobs running (bin4)
      // Offset 48: batch jobs waiting for message (bin4)
      // Offset 52: batch jobs held on job queue (bin4)
      // Offset 56: batch jobs ending (bin4)
      // Offset 60: percent system ASP used (bin4) -- actually percentage * 10000
      // Offset 64: total auxiliary storage (bin4) in MB
      // Offset 68: system ASP (bin4) in MB
      // Offset 72: percent processing unit used (bin4) -- percentage * 10
      // Offset 76: jobs in system (bin4)
      // Offset 80: percent permanent addresses used (bin4)
      // Offset 84: percent temporary addresses used (bin4)
      // Offset 88: number of processors (bin4)
      // Offset 92: active jobs in system (bin4)

      this.#info.currentDateTime = conv.byteArrayToString(outBuf, 8, 8).trim();
      this.#info.systemName = conv.byteArrayToString(outBuf, 16, 8).trim();
      this.#info.usersCurrentSignedOn = outBuf.readInt32BE(24);
      this.#info.usersTemporarilySignedOff = outBuf.readInt32BE(28);
      this.#info.usersSuspendedByGroupJobs = outBuf.readInt32BE(32);
      this.#info.usersSuspendedBySystemRequest = outBuf.readInt32BE(36);
      this.#info.usersSignedOffWithPrinterOutput = outBuf.readInt32BE(40);
      this.#info.batchJobsRunning = outBuf.readInt32BE(44);
      this.#info.batchJobsWaiting = outBuf.readInt32BE(48);
      this.#info.batchJobsHeldOnJobQueue = outBuf.readInt32BE(52);
      this.#info.batchJobsEnding = outBuf.readInt32BE(56);
      this.#info.percentSystemASPUsed = outBuf.readInt32BE(60) / 10000;
      this.#info.totalAuxiliaryStorage = outBuf.readInt32BE(64);
      this.#info.systemASP = outBuf.readInt32BE(68);
      this.#info.percentProcessingUnitUsed = outBuf.readInt32BE(72) / 10;
      this.#info.jobsInSystem = outBuf.readInt32BE(76);

      if (outBuf.length >= 96) {
        this.#info.percentPermanentAddresses = outBuf.readInt32BE(80);
        this.#info.percentTemporaryAddresses = outBuf.readInt32BE(84);
        this.#info.numberOfProcessors = outBuf.readInt32BE(88);
        this.#info.activeJobsInSystem = outBuf.readInt32BE(92);
      }
    }

    this.#loaded = true;
  }
}
