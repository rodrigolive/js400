/**
 * Cursor and fetch state manager.
 *
 * Tracks open cursors, their descriptors, and fetch state.
 * Each cursor is identified by its RPB ID.
 *
 * Upstream: JDCursor*.java
 * @module db/engine/CursorManager
 */

import { DBRequestDS } from '../protocol/DBRequestDS.js';
import { parseFetchReply, throwIfError } from '../protocol/DBReplyDS.js';
import { decodeResultData } from '../types/factory.js';

export class CursorManager {
  #connection;
  #serverCCSID;
  #cursors;

  constructor(connection, opts = {}) {
    this.#connection = connection;
    this.#serverCCSID = opts.serverCCSID ?? 37;
    this.#cursors = new Map();
  }

  registerCursor(rpbId, descriptors) {
    this.#cursors.set(rpbId, {
      rpbId,
      descriptors,
      open: true,
      endOfData: false,
      totalFetched: 0,
    });
  }

  getCursor(rpbId) {
    return this.#cursors.get(rpbId) ?? null;
  }

  async fetch(rpbId, count = 1) {
    const cursor = this.#cursors.get(rpbId);
    if (!cursor || !cursor.open) {
      throw new Error(`Cursor ${rpbId} is not open`);
    }
    if (cursor.endOfData) return [];

    const reqBuf = DBRequestDS.buildFetch({ rpbId, fetchCount: count });
    const replyBuf = await this.#connection.sendAndReceive(reqBuf);
    const reply = parseFetchReply(replyBuf, { serverCCSID: this.#serverCCSID });

    if (reply.sqlca.isError && reply.sqlca.sqlCode !== 100) {
      throwIfError(reply.sqlca, 'Fetch');
    }

    if (reply.endOfData) {
      cursor.endOfData = true;
    }

    const rows = [];
    for (const dataBuf of reply.rowDataBuffers) {
      const decoded = decodeResultData(dataBuf, cursor.descriptors, this.#serverCCSID);
      rows.push(...decoded);
    }

    cursor.totalFetched += rows.length;
    return rows;
  }

  async fetchAll(rpbId, opts = {}) {
    const blockSize = opts.blockSize ?? 100;
    const maxRows = opts.maxRows ?? Infinity;
    const allRows = [];

    while (allRows.length < maxRows) {
      const batch = Math.min(blockSize, maxRows - allRows.length);
      const rows = await this.fetch(rpbId, batch);
      if (rows.length === 0) break;
      allRows.push(...rows);
    }

    return allRows;
  }

  async closeCursor(rpbId) {
    const cursor = this.#cursors.get(rpbId);
    if (!cursor || !cursor.open) return;

    const reqBuf = DBRequestDS.buildCloseCursor({ rpbId });
    const replyBuf = await this.#connection.sendAndReceive(reqBuf);
    const reply = parseFetchReply(replyBuf, { serverCCSID: this.#serverCCSID });

    // Ignore "cursor not open" errors during close
    if (reply.sqlca.isError && reply.sqlca.sqlCode !== -501) {
      throwIfError(reply.sqlca, 'Close cursor');
    }

    cursor.open = false;
    this.#cursors.delete(rpbId);
  }

  async closeAll() {
    const rpbIds = [...this.#cursors.keys()];
    for (const rpbId of rpbIds) {
      try {
        await this.closeCursor(rpbId);
      } catch {
        this.#cursors.delete(rpbId);
      }
    }
  }

  get openCursorCount() {
    return this.#cursors.size;
  }
}
