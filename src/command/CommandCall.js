/**
 * CL command execution on IBM i.
 *
 * Usage:
 *   const cmd = new CommandCall(system);
 *   const ok = await cmd.run("CRTLIB LIB(TESTLIB)");
 *   for (const msg of cmd.getMessageList()) {
 *     console.log(`${msg.id}: ${msg.text}`);
 *   }
 *
 * Upstream: CommandCall.java
 * @module command/CommandCall
 */

import { Trace } from '../core/Trace.js';
import { CommandReq, MSG_OPT_ALL } from './protocol/CommandReq.js';
import { CommandRep, RC_SUCCESS } from './protocol/CommandRep.js';
import { ensureCommandConnection } from './RemoteCommandConnection.js';

export class CommandCall {
  /** @type {import('../core/AS400.js').AS400} */
  #system;
  /** @type {string} */
  #command = '';
  /** @type {import('../core/AS400Message.js').AS400Message[]} */
  #messageList = [];
  /** @type {boolean} */
  #threadsafe = false;
  /** @type {number} */
  #messageOption = MSG_OPT_ALL;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} [command] - Optional initial command string
   */
  constructor(system, command) {
    if (!system) throw new Error('CommandCall requires an AS400 instance');
    this.#system = system;
    if (command) this.#command = command;
  }

  /** Set the command string. */
  setCommand(cmd) { this.#command = cmd; }

  /** Get the command string. */
  getCommand() { return this.#command; }

  /** Set threadsafe flag. */
  setThreadsafe(v) { this.#threadsafe = !!v; }

  /** Get threadsafe flag. */
  isThreadsafe() { return this.#threadsafe; }

  /** Set message option (MSG_OPT_ALL, MSG_OPT_NONE, MSG_OPT_UP_TO_10). */
  setMessageOption(opt) { this.#messageOption = opt; }

  /** Get messages from the last call. */
  getMessageList() { return this.#messageList; }

  /**
   * Run a CL command.
   *
   * @param {string} [command] - Command string (overrides stored command)
   * @returns {Promise<boolean>} true if command succeeded
   */
  async run(command) {
    const cmdStr = command || this.#command;
    if (!cmdStr) throw new Error('No command specified');

    if (command) this.#command = command;
    this.#messageList = [];

    const state = await ensureCommandConnection(this.#system);
    const { connection: conn, datastreamLevel, ccsid } = state;

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, `CommandCall.run: ${cmdStr}`);
    }

    const reqBuf = CommandReq.buildRunCommand({
      command: cmdStr,
      datastreamLevel,
      ccsid,
      messageOption: this.#messageOption,
    });

    const replyBuf = await conn.sendAndReceive(reqBuf);

    const reply = CommandRep.parseCallReply(replyBuf, {
      datastreamLevel,
      ccsid,
      parameterCount: 0,
    });

    this.#messageList = reply.messages;

    const success = reply.returnCode === RC_SUCCESS;

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `CommandCall.run: rc=${reply.returnCode}, msgs=${reply.messages.length}, success=${success}`);
    }

    return success;
  }
}
