/**
 * Transaction management and savepoints.
 *
 * Upstream: JDTransactionManager.java
 * @module db/engine/TransactionManager
 */

import { DBRequestDS } from '../protocol/DBRequestDS.js';
import { parseOperationReply, throwIfError } from '../protocol/DBReplyDS.js';

let savepointCounter = 0;

export class Savepoint {
  #id;
  #name;

  constructor(name) {
    this.#id = ++savepointCounter;
    this.#name = name || `SP_${this.#id}`;
  }

  get id() { return this.#id; }
  get name() { return this.#name; }
}

export class TransactionManager {
  #connection;
  #serverCCSID;
  #autoCommit;
  #savepoints;

  constructor(connection, opts = {}) {
    this.#connection = connection;
    this.#serverCCSID = opts.serverCCSID ?? 37;
    this.#autoCommit = opts.autoCommit ?? true;
    this.#savepoints = new Map();
  }

  get autoCommit() { return this.#autoCommit; }

  set autoCommit(val) {
    this.#autoCommit = !!val;
  }

  async commit() {
    const reqBuf = DBRequestDS.buildCommit();
    const replyBuf = await this.#connection.sendAndReceive(reqBuf);
    const reply = parseOperationReply(replyBuf, { serverCCSID: this.#serverCCSID });
    throwIfError(reply.sqlca, 'Commit');
    this.#savepoints.clear();
    return reply.sqlca;
  }

  async rollback() {
    const reqBuf = DBRequestDS.buildRollback();
    const replyBuf = await this.#connection.sendAndReceive(reqBuf);
    const reply = parseOperationReply(replyBuf, { serverCCSID: this.#serverCCSID });
    throwIfError(reply.sqlca, 'Rollback');
    this.#savepoints.clear();
    return reply.sqlca;
  }

  async setSavepoint(name) {
    const sp = new Savepoint(name);
    const sql = `SAVEPOINT "${sp.name}" ON ROLLBACK RETAIN CURSORS`;
    const sqlca = await this.#executeImmediate(sql);
    this.#savepoints.set(sp.name, sp);
    return { savepoint: sp, sqlca };
  }

  async rollbackToSavepoint(savepoint) {
    const name = typeof savepoint === 'string' ? savepoint : savepoint.name;
    const sql = `ROLLBACK TO SAVEPOINT "${name}"`;
    return this.#executeImmediate(sql);
  }

  async releaseSavepoint(savepoint) {
    const name = typeof savepoint === 'string' ? savepoint : savepoint.name;
    const sql = `RELEASE SAVEPOINT "${name}"`;
    const sqlca = await this.#executeImmediate(sql);
    this.#savepoints.delete(name);
    return sqlca;
  }

  async #executeImmediate(sql) {
    const reqBuf = DBRequestDS.buildExecuteImmediate({ rpbId: 0, sqlText: sql });
    const replyBuf = await this.#connection.sendAndReceive(reqBuf);
    const reply = parseOperationReply(replyBuf, { serverCCSID: this.#serverCCSID });
    throwIfError(reply.sqlca, sql);
    return reply.sqlca;
  }

  async autoCommitIfNeeded() {
    if (this.#autoCommit) {
      await this.commit();
    }
  }
}
