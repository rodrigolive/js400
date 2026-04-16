/**
 * Spooled file metadata and content access.
 *
 * Represents a spooled file in an output queue. Supports hold, release,
 * delete, and content read operations.
 *
 * Upstream: SpooledFile.java, SpooledFileList.java
 * @module print/SpooledFile
 */

import { PrintError } from '../core/errors.js';

export class SpooledFile {
  #system;
  #name;
  #jobName;
  #jobUser;
  #jobNumber;
  #spooledFileNumber;
  #totalPages;
  #outputQueue;
  #outputQueueLibrary;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} name - Spooled file name
   * @param {object} [opts]
   * @param {string} [opts.jobName]
   * @param {string} [opts.jobUser]
   * @param {string} [opts.jobNumber]
   * @param {number} [opts.spooledFileNumber=1]
   * @param {number} [opts.totalPages=0]
   * @param {string} [opts.outputQueue]
   * @param {string} [opts.outputQueueLibrary]
   */
  constructor(system, name, opts = {}) {
    if (!system) throw new Error('SpooledFile requires an AS400 instance');
    if (!name) throw new Error('SpooledFile requires a name');
    this.#system = system;
    this.#name = name;
    this.#jobName = opts.jobName ?? '';
    this.#jobUser = opts.jobUser ?? '';
    this.#jobNumber = opts.jobNumber ?? '';
    this.#spooledFileNumber = opts.spooledFileNumber ?? 1;
    this.#totalPages = opts.totalPages ?? 0;
    this.#outputQueue = opts.outputQueue ?? '';
    this.#outputQueueLibrary = opts.outputQueueLibrary ?? '';
  }

  getName() { return this.#name; }
  getJobName() { return this.#jobName; }
  getJobUser() { return this.#jobUser; }
  getJobNumber() { return this.#jobNumber; }
  getNumber() { return this.#spooledFileNumber; }
  getTotalPages() { return this.#totalPages; }
  getOutputQueue() { return this.#outputQueue; }
  getOutputQueueLibrary() { return this.#outputQueueLibrary; }

  /**
   * Hold the spooled file.
   * @returns {Promise<void>}
   */
  async hold() {
    const cmd = `HLDSPLF FILE(${this.#name})` +
      ` JOB(${this.#jobNumber}/${this.#jobUser}/${this.#jobName})` +
      ` SPLNBR(${this.#spooledFileNumber})`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new PrintError(
        `SpooledFile hold failed: ${errMsg.text}`,
        { messageId: errMsg.id },
      );
    }
  }

  /**
   * Release the spooled file.
   * @returns {Promise<void>}
   */
  async release() {
    const cmd = `RLSSPLF FILE(${this.#name})` +
      ` JOB(${this.#jobNumber}/${this.#jobUser}/${this.#jobName})` +
      ` SPLNBR(${this.#spooledFileNumber})`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new PrintError(
        `SpooledFile release failed: ${errMsg.text}`,
        { messageId: errMsg.id },
      );
    }
  }

  /**
   * Delete the spooled file.
   * @returns {Promise<void>}
   */
  async delete() {
    const cmd = `DLTSPLF FILE(${this.#name})` +
      ` JOB(${this.#jobNumber}/${this.#jobUser}/${this.#jobName})` +
      ` SPLNBR(${this.#spooledFileNumber})`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new PrintError(
        `SpooledFile delete failed: ${errMsg.text}`,
        { messageId: errMsg.id },
      );
    }
  }

  /**
   * Move spooled file to a different output queue.
   * @param {string} outputQueuePath - IFS path like /QSYS.LIB/LIB.LIB/OUTQ.OUTQ
   * @returns {Promise<void>}
   */
  async move(outputQueuePath) {
    const { QSYSObjectPathName } = await import('../ifs/QSYSObjectPathName.js');
    const parsed = QSYSObjectPathName.parse(outputQueuePath);
    const cmd = `CHGSPLFA FILE(${this.#name})` +
      ` JOB(${this.#jobNumber}/${this.#jobUser}/${this.#jobName})` +
      ` SPLNBR(${this.#spooledFileNumber})` +
      ` OUTQ(${parsed.library}/${parsed.object})`;
    const msgs = await this.#system.runCommand(cmd);
    const errMsg = msgs.find(m => m.severity >= 30);
    if (errMsg) {
      throw new PrintError(
        `SpooledFile move failed: ${errMsg.text}`,
        { messageId: errMsg.id },
      );
    }
    this.#outputQueue = parsed.object;
    this.#outputQueueLibrary = parsed.library;
  }

  toString() {
    return `${this.#name} (${this.#jobNumber}/${this.#jobUser}/${this.#jobName} #${this.#spooledFileNumber})`;
  }
}
