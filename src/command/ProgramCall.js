/**
 * Program call API for invoking IBM i programs.
 *
 * Usage:
 *   const pc = new ProgramCall(system);
 *   pc.setProgram("/QSYS.LIB/MYLIB.LIB/MYPGM.PGM", params);
 *   const ok = await pc.run();
 *   if (!ok) console.log(pc.getMessageList());
 *
 * Upstream: ProgramCall.java
 * @module command/ProgramCall
 */

import { Trace } from '../core/Trace.js';
import { AS400Error } from '../core/errors.js';
import { CommandReq, MSG_OPT_ALL } from './protocol/CommandReq.js';
import { CommandRep, RC_SUCCESS } from './protocol/CommandRep.js';
import { ensureCommandConnection } from './RemoteCommandConnection.js';

export class ProgramCall {
  /** @type {import('../core/AS400.js').AS400} */
  #system;
  /** @type {string} */
  #program = '';
  /** @type {import('./ProgramParameter.js').ProgramParameter[]} */
  #parameters = [];
  /** @type {import('../core/AS400Message.js').AS400Message[]} */
  #messageList = [];
  /** @type {boolean} */
  #threadsafe = false;
  /** @type {number} */
  #messageOption = MSG_OPT_ALL;

  /**
   * @param {import('../core/AS400.js').AS400} system
   */
  constructor(system) {
    if (!system) throw new Error('ProgramCall requires an AS400 instance');
    this.#system = system;
  }

  /**
   * Set the program to call.
   *
   * @param {string} program - IFS path or lib/pgm name
   * @param {import('./ProgramParameter.js').ProgramParameter[]} [parameters]
   */
  setProgram(program, parameters) {
    this.#program = program;
    if (parameters) this.#parameters = parameters;
  }

  /** Get program path. */
  getProgram() { return this.#program; }

  /** Set parameter list. */
  setParameterList(params) { this.#parameters = params; }

  /** Get parameter list. */
  getParameterList() { return this.#parameters; }

  /** Set threadsafe flag. */
  setThreadsafe(v) { this.#threadsafe = !!v; }

  /** Get threadsafe flag. */
  isThreadsafe() { return this.#threadsafe; }

  /** Set message option (MSG_OPT_ALL, MSG_OPT_NONE, MSG_OPT_UP_TO_10). */
  setMessageOption(opt) { this.#messageOption = opt; }

  /** Get messages from the last call. */
  getMessageList() { return this.#messageList; }

  /**
   * Run the program.
   *
   * @returns {Promise<boolean>} true if the program ran without error
   */
  async run() {
    if (!this.#program) {
      throw new Error('No program set');
    }

    this.#messageList = [];

    const state = await ensureCommandConnection(this.#system);
    const { connection: conn, datastreamLevel, ccsid } = state;

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `ProgramCall.run: ${this.#program}, params=${this.#parameters.length}`);
    }

    // Count output parameters for reply parsing
    let outputParamCount = 0;
    for (const p of this.#parameters) {
      if (p.getUsage() === 2 || p.getUsage() === 3) {
        outputParamCount++;
      }
    }

    const reqBuf = CommandReq.buildCallProgram({
      programPath: this.#program,
      parameters: this.#parameters,
      datastreamLevel,
      ccsid,
      messageOption: this.#messageOption,
    });

    const replyBuf = await conn.sendAndReceive(reqBuf);

    const reply = CommandRep.parseCallReply(replyBuf, {
      datastreamLevel,
      ccsid,
      parameterCount: outputParamCount,
    });

    this.#messageList = reply.messages;

    // Populate output data on parameters
    let outIdx = 0;
    for (const p of this.#parameters) {
      const usage = p.getUsage();
      if (usage === 2 || usage === 3) {
        if (outIdx < reply.outputParameters.length) {
          p.setOutputData(reply.outputParameters[outIdx]);
        }
        outIdx++;
      }
    }

    const success = reply.returnCode === RC_SUCCESS;

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `ProgramCall.run: rc=${reply.returnCode}, msgs=${reply.messages.length}, success=${success}`);
    }

    return success;
  }
}
