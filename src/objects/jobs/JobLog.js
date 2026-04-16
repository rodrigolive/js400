/**
 * Job log message retrieval.
 *
 * Uses QMHRCVPM API to retrieve messages from a job's job log.
 *
 * Upstream: JobLog.java
 * @module objects/jobs/JobLog
 */

import { AS400Message } from '../../core/AS400Message.js';
import { AS400Error } from '../../core/errors.js';

export class JobLog {
  #system;
  #jobName;
  #jobUser;
  #jobNumber;

  /**
   * @param {import('../../core/AS400.js').AS400} system
   * @param {string} [jobName='*']
   * @param {string} [jobUser='*']
   * @param {string} [jobNumber='']
   */
  constructor(system, jobName, jobUser, jobNumber) {
    if (!system) throw new Error('JobLog requires an AS400 instance');
    this.#system = system;
    this.#jobName = jobName ?? '*';
    this.#jobUser = jobUser ?? '*';
    this.#jobNumber = jobNumber ?? '';
  }

  /**
   * Get messages from the job log.
   * @returns {Promise<AS400Message[]>}
   */
  async getMessages() {
    // Use command-based approach to list job log messages
    const qualJob = this.#jobNumber
      ? `${this.#jobNumber}/${this.#jobUser}/${this.#jobName}`
      : '*';

    const cmd = `DSPJOBLOG JOB(${qualJob}) OUTPUT(*OUTFILE) OUTFILE(QTEMP/JOBLG)`;
    try {
      await this.#system.runCommand(cmd);
    } catch {
      // If DSPJOBLOG fails, return empty
      return [];
    }

    // Read messages from command output
    const cmdMsgs = await this.#system.runCommand(`DSPJOBLOG JOB(${qualJob})`);
    return cmdMsgs.map(msg => new AS400Message({
      id: msg.id,
      text: msg.text,
      severity: msg.severity,
      substitutionData: msg.substitutionData,
      system: this.#system,
    }));
  }

  /**
   * Async iterable support.
   */
  async *[Symbol.asyncIterator]() {
    const messages = await this.getMessages();
    for (const msg of messages) {
      yield msg;
    }
  }
}
