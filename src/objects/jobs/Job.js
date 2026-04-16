/**
 * Job metadata and inspection API.
 *
 * Uses QUSRJOBI API via program calls.
 *
 * Upstream: Job.java
 * @module objects/jobs/Job
 */

import { AS400Error } from '../../core/errors.js';

export class Job {
  #system;
  #name;
  #user;
  #number;
  #info;

  /**
   * @param {import('../../core/AS400.js').AS400} system
   * @param {string} [user='*']
   * @param {string} [name='*']
   * @param {string} [number='']
   */
  constructor(system, user, name, number) {
    if (!system) throw new Error('Job requires an AS400 instance');
    this.#system = system;
    this.#name = name ?? '*';
    this.#user = user ?? '*';
    this.#number = number ?? '';
    this.#info = {};
  }

  getName() { return this.#info.jobName ?? this.#name; }
  getUser() { return this.#info.userName ?? this.#user; }
  getNumber() { return this.#info.jobNumber ?? this.#number; }
  getStatus() { return this.#info.activeStatus ?? ''; }
  getType() { return this.#info.jobType ?? ''; }
  getSubtype() { return this.#info.jobSubtype ?? ''; }
  getCPUUsed() { return this.#info.cpuUsed ?? 0; }
  getRunPriority() { return this.#info.runPriority ?? 0; }
  getSubsystem() { return this.#info.subsystem ?? ''; }
  getInfo() { return { ...this.#info }; }

  /**
   * Load job information from the system.
   * Uses QUSRJOBI API with format JOBI0200.
   *
   * @returns {Promise<void>}
   */
  async loadInformation() {
    const { ProgramCall } = await import('../../command/ProgramCall.js');
    const { ProgramParameter } = await import('../../command/ProgramParameter.js');
    const { CharConverter } = await import('../../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    const outLen = 1024;

    const formatBuf = Buffer.alloc(8, 0x40);
    conv.stringToByteArray('JOBI0200').copy(formatBuf, 0, 0, 8);

    const qualJobName = Buffer.alloc(26, 0x40);
    conv.stringToByteArray(this.#name.toUpperCase().padEnd(10, ' ')).copy(qualJobName, 0, 0, 10);
    conv.stringToByteArray(this.#user.toUpperCase().padEnd(10, ' ')).copy(qualJobName, 10, 0, 10);
    conv.stringToByteArray(this.#number.padStart(6, ' ')).copy(qualJobName, 20, 0, 6);

    const intJobId = Buffer.alloc(16, 0x40);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(outLen, 0);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QUSRJOBI.PGM', [
      new ProgramParameter({ outputLength: outLen }),
      new ProgramParameter({ inputData: lenBuf }),
      new ProgramParameter({ inputData: formatBuf }),
      new ProgramParameter({ inputData: qualJobName }),
      new ProgramParameter({ inputData: intJobId }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const success = await pc.run();
    if (!success) {
      const msgs = pc.getMessageList();
      throw new AS400Error(
        `Job loadInformation failed: ${msgs[0]?.text ?? 'unknown error'}`,
        { messageId: msgs[0]?.id, hostService: 'COMMAND' },
      );
    }

    const outBuf = pc.getParameterList()[0].getOutputData();
    if (outBuf && outBuf.length >= 60) {
      this.#info.jobName = conv.byteArrayToString(outBuf, 8, 10).trim();
      this.#info.userName = conv.byteArrayToString(outBuf, 18, 10).trim();
      this.#info.jobNumber = conv.byteArrayToString(outBuf, 28, 6).trim();
      this.#info.activeStatus = conv.byteArrayToString(outBuf, 50, 10).trim();

      if (outBuf.length >= 76) {
        this.#info.jobType = conv.byteArrayToString(outBuf, 60, 1).trim();
        this.#info.jobSubtype = conv.byteArrayToString(outBuf, 61, 1).trim();
        this.#info.subsystem = conv.byteArrayToString(outBuf, 62, 10).trim();
        this.#info.runPriority = outBuf.readInt32BE(72);
      }

      if (outBuf.length >= 84) {
        this.#info.cpuUsed = outBuf.readInt32BE(80);
      }
    }
  }

  toString() {
    return `${this.getNumber()}/${this.getUser()}/${this.getName()}`;
  }
}
