/**
 * Service program call API for invoking IBM i service programs.
 *
 * Service programs are invoked via the QZRUCLSP API, which is called
 * as a regular program with specially structured parameters.
 *
 * Upstream: ServiceProgramCall.java
 * @module command/ServiceProgramCall
 */

import { Trace } from '../core/Trace.js';
import { CommandReq, MSG_OPT_ALL } from './protocol/CommandReq.js';
import { CommandRep, RC_SUCCESS } from './protocol/CommandRep.js';
import { ProgramParameter } from './ProgramParameter.js';
import { AS400Bin4 } from '../datatypes/AS400Bin4.js';
import { AS400Text } from '../datatypes/AS400Text.js';
import { ensureCommandConnection } from './RemoteCommandConnection.js';

/** Return value format constants. */
const NO_RETURN_VALUE = 0;
const RETURN_INTEGER = 1;

const BIN4 = new AS400Bin4();

export class ServiceProgramCall {
  static NO_RETURN_VALUE = NO_RETURN_VALUE;
  static RETURN_INTEGER = RETURN_INTEGER;

  /** @type {import('../core/AS400.js').AS400} */
  #system;
  /** @type {string} */
  #program = '';
  /** @type {string} */
  #procedureName = '';
  /** @type {number} */
  #returnValueFormat = NO_RETURN_VALUE;
  /** @type {ProgramParameter[]} */
  #parameters = [];
  /** @type {import('../core/AS400Message.js').AS400Message[]} */
  #messageList = [];
  /** @type {number} */
  #messageOption = MSG_OPT_ALL;
  /** @type {number} */
  #returnValue = 0;
  /** @type {number} */
  #errno = 0;
  /** @type {boolean} */
  #threadsafe = false;
  /** @type {number} */
  #epccsid = 0;

  /**
   * @param {import('../core/AS400.js').AS400} system
   */
  constructor(system) {
    if (!system) throw new Error('ServiceProgramCall requires an AS400 instance');
    this.#system = system;
  }

  /** Set the service program IFS path. */
  setProgram(program) { this.#program = program; }
  getProgram() { return this.#program; }

  /** Set the exported procedure name. */
  setProcedureName(name) { this.#procedureName = name; }
  getProcedureName() { return this.#procedureName; }

  /** Set return value format (NO_RETURN_VALUE or RETURN_INTEGER). */
  setReturnValueFormat(fmt) { this.#returnValueFormat = fmt; }
  getReturnValueFormat() { return this.#returnValueFormat; }

  /** Set parameter list. */
  setParameterList(params) { this.#parameters = params; }
  getParameterList() { return this.#parameters; }

  /** Get messages from the last call. */
  getMessageList() { return this.#messageList; }

  /** Set message option. */
  setMessageOption(opt) { this.#messageOption = opt; }

  /** Set threadsafe flag. */
  setThreadsafe(v) { this.#threadsafe = !!v; }
  isThreadsafe() { return this.#threadsafe; }

  /** Set entry-point CCSID. */
  setEPCCSID(ccsid) { this.#epccsid = ccsid; }
  getEPCCSID() { return this.#epccsid; }

  /** Get the integer return value from the last call. */
  getIntegerReturnValue() { return this.#returnValue; }

  /** Get errno from the last call. */
  getErrno() { return this.#errno; }

  /**
   * Run the service program procedure.
   *
   * The service program is called via QZRUCLSP, which takes:
   *   1. Service program qualified name (20 bytes)
   *   2. Export procedure name (variable, null-terminated)
   *   3. Return value format (BIN4)
   *   4. Parameter formats array (BIN4 per param)
   *   5. Number of parameters (BIN4)
   *   6. Error code structure (BIN4*8 = 32 bytes)
   *   7. Return value output (8 bytes)
   *   8+. User parameters
   *
   * @returns {Promise<boolean>}
   */
  async run() {
    if (!this.#program) throw new Error('No service program set');
    if (!this.#procedureName) throw new Error('No procedure name set');

    this.#messageList = [];
    this.#returnValue = 0;
    this.#errno = 0;

    const state = await ensureCommandConnection(this.#system);
    const { connection: conn, datastreamLevel, ccsid } = state;

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `ServiceProgramCall.run: ${this.#program}.${this.#procedureName}, params=${this.#parameters.length}`);
    }

    // Build QZRUCLSP parameters
    const apiParams = this.#buildQzruclspParams(ccsid);

    const reqBuf = CommandReq.buildCallProgram({
      programPath: '/QSYS.LIB/QZRUCLSP.PGM',
      parameters: apiParams,
      datastreamLevel,
      ccsid,
      messageOption: this.#messageOption,
    });

    const replyBuf = await conn.sendAndReceive(reqBuf);

    // Count output params for QZRUCLSP
    let outputCount = 0;
    for (const p of apiParams) {
      if (p.getUsage() === 2 || p.getUsage() === 3) outputCount++;
    }

    const reply = CommandRep.parseCallReply(replyBuf, {
      datastreamLevel,
      ccsid,
      parameterCount: outputCount,
    });

    this.#messageList = reply.messages;

    // Extract return value and user output parameters
    this.#processQzruclspReply(apiParams, reply.outputParameters);

    const success = reply.returnCode === RC_SUCCESS;

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `ServiceProgramCall.run: rc=${reply.returnCode}, returnValue=${this.#returnValue}, success=${success}`);
    }

    return success;
  }

  /**
   * Build the parameter list for QZRUCLSP.
   * @param {number} ccsid
   * @returns {ProgramParameter[]}
   */
  #buildQzruclspParams(ccsid) {
    const params = [];
    const userParams = this.#parameters;
    const numUserParams = userParams.length;

    // 1. Service program qualified name (20 bytes: 10 name + 10 library)
    const { programName, libraryName } = ServiceProgramCall.#parseSrvpgmPath(this.#program);
    const nameConv = new AS400Text(10, ccsid);
    const qualName = Buffer.alloc(20);
    nameConv.toBuffer(programName).copy(qualName, 0);
    nameConv.toBuffer(libraryName).copy(qualName, 10);
    params.push(new ProgramParameter(qualName));

    // 2. Export procedure name (null-terminated, variable length)
    const procNameCcsid = this.#epccsid || ccsid;
    const procConv = new AS400Text(this.#procedureName.length, procNameCcsid);
    const procBytes = procConv.toBuffer(this.#procedureName);
    const procBuf = Buffer.alloc(procBytes.length + 1);
    procBytes.copy(procBuf);
    procBuf[procBytes.length] = 0x00; // null terminator
    params.push(new ProgramParameter(procBuf));

    // 3. Return value format (BIN4)
    params.push(new ProgramParameter(BIN4.toBuffer(this.#returnValueFormat)));

    // 4. Parameter formats array (BIN4 per user param)
    if (numUserParams > 0) {
      const fmtBuf = Buffer.alloc(numUserParams * 4);
      for (let i = 0; i < numUserParams; i++) {
        const passBy = userParams[i].getPassBy();
        fmtBuf.writeInt32BE(passBy, i * 4);
      }
      params.push(new ProgramParameter(fmtBuf));
    } else {
      params.push(new ProgramParameter(BIN4.toBuffer(0)));
    }

    // 5. Number of parameters (BIN4)
    params.push(new ProgramParameter(BIN4.toBuffer(numUserParams)));

    // 6. Error code structure (32 bytes, input 0 = use exceptions)
    const errBuf = Buffer.alloc(32);
    params.push(new ProgramParameter(errBuf, 32));

    // 7. Return value output (8 bytes)
    params.push(new ProgramParameter(Buffer.alloc(8), 8));

    // 8+. User parameters
    for (const p of userParams) {
      params.push(p);
    }

    return params;
  }

  /**
   * Process QZRUCLSP reply outputs.
   * @param {ProgramParameter[]} apiParams
   * @param {Buffer[]} outputBuffers
   */
  #processQzruclspReply(apiParams, outputBuffers) {
    // Map output buffers back to the api params that have output usage
    let outIdx = 0;
    for (const p of apiParams) {
      const usage = p.getUsage();
      if (usage === 2 || usage === 3) {
        if (outIdx < outputBuffers.length) {
          p.setOutputData(outputBuffers[outIdx]);
        }
        outIdx++;
      }
    }

    // Extract return value from param #7 (index 6)
    const retParam = apiParams[6];
    const retData = retParam.getOutputData();
    if (retData && retData.length >= 4) {
      this.#returnValue = retData.readInt32BE(0);
      if (retData.length >= 8) {
        this.#errno = retData.readInt32BE(4);
      }
    }

    // Copy output data from user params (apiParams[7+])
    for (let i = 0; i < this.#parameters.length; i++) {
      const apiParam = apiParams[7 + i];
      if (apiParam) {
        const outData = apiParam.getOutputData();
        if (outData) {
          this.#parameters[i].setOutputData(outData);
        }
      }
    }
  }

  /**
   * Parse service program path.
   * @param {string} path
   * @returns {{ programName: string, libraryName: string }}
   */
  static #parseSrvpgmPath(path) {
    const normalized = path.trim().toUpperCase();
    if (normalized.startsWith('/')) {
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length >= 3) {
        return {
          programName: parts[2].replace(/\.SRVPGM$/i, ''),
          libraryName: parts[1].replace(/\.LIB$/i, ''),
        };
      }
      if (parts.length === 2) {
        return {
          programName: parts[1].replace(/\.SRVPGM$/i, ''),
          libraryName: '*LIBL',
        };
      }
    }
    if (normalized.includes('/')) {
      const [lib, pgm] = normalized.split('/');
      return {
        programName: pgm.replace(/\.SRVPGM$/i, ''),
        libraryName: lib || '*LIBL',
      };
    }
    return { programName: normalized.replace(/\.SRVPGM$/i, ''), libraryName: '*LIBL' };
  }
}
