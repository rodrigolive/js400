/**
 * Result set API with async iteration.
 *
 * Wraps cursor-based fetching from the engine layer into
 * an ergonomic JS interface with async iteration, object/array modes,
 * and metadata access.
 *
 * Upstream: AS400JDBCResultSet*.java
 * @module db/api/ResultSet
 */

export class ResultSet {
  #rows;
  #columnDescriptors;
  #cursorManager;
  #rpbId;
  #endOfData;
  #fetchSize;
  #serverCCSID;
  #position;
  #closed;

  /**
   * @param {object} opts
   * @param {object[]} opts.rows - initial rows already fetched
   * @param {object[]} opts.columnDescriptors
   * @param {object} [opts.cursorManager] - for fetching more rows
   * @param {number} [opts.rpbId] - RPB ID for cursor fetches
   * @param {boolean} [opts.endOfData=true]
   * @param {number} [opts.fetchSize=100]
   * @param {number} [opts.serverCCSID=37]
   */
  constructor(opts = {}) {
    this.#rows = opts.rows || [];
    this.#columnDescriptors = opts.columnDescriptors || [];
    this.#cursorManager = opts.cursorManager || null;
    this.#rpbId = opts.rpbId ?? 0;
    this.#endOfData = opts.endOfData ?? true;
    this.#fetchSize = opts.fetchSize ?? 100;
    this.#serverCCSID = opts.serverCCSID ?? 37;
    this.#position = 0;
    this.#closed = false;
  }

  get length() { return this.#rows.length; }
  get columns() { return this.#columnDescriptors; }
  get closed() { return this.#closed; }

  /**
   * Get column metadata.
   * @returns {object[]}
   */
  get metadata() {
    return this.#columnDescriptors.map(desc => ({
      name: desc.name || desc.label || `COL${desc.index}`,
      label: desc.label || desc.name || '',
      typeName: desc.typeName,
      sqlType: desc.sqlType,
      precision: desc.precision,
      scale: desc.scale,
      nullable: desc.nullable,
      tableName: desc.tableName || '',
      schemaName: desc.schemaName || '',
    }));
  }

  /**
   * Get all rows as an array.
   * If the cursor is still open, fetches all remaining rows first.
   * @returns {Promise<object[]>}
   */
  async toArray() {
    if (!this.#endOfData && this.#cursorManager) {
      await this.#fetchRemaining();
    }
    return [...this.#rows];
  }

  /**
   * Get a specific row by index.
   * @param {number} index
   * @returns {object|undefined}
   */
  get(index) {
    return this.#rows[index];
  }

  /**
   * Synchronous iterator over already-fetched rows.
   */
  [Symbol.iterator]() {
    let i = 0;
    const rows = this.#rows;
    return {
      next() {
        if (i < rows.length) {
          return { value: rows[i++], done: false };
        }
        return { done: true };
      },
    };
  }

  /**
   * Async iterator that fetches rows on demand.
   * Yields one row at a time, fetching more from the server as needed.
   */
  async *[Symbol.asyncIterator]() {
    // Yield already-fetched rows
    for (let i = 0; i < this.#rows.length; i++) {
      yield this.#rows[i];
    }

    // Fetch more if cursor is still open
    while (!this.#endOfData && this.#cursorManager && !this.#closed) {
      const batch = await this.#cursorManager.fetch(this.#rpbId, this.#fetchSize);
      if (batch.length === 0) {
        this.#endOfData = true;
        break;
      }
      this.#rows.push(...batch);
      for (const row of batch) {
        yield row;
      }
    }
  }

  /**
   * Fetch all remaining rows from the server cursor.
   */
  async #fetchRemaining() {
    while (!this.#endOfData && this.#cursorManager) {
      const batch = await this.#cursorManager.fetch(this.#rpbId, this.#fetchSize);
      if (batch.length === 0) {
        this.#endOfData = true;
        break;
      }
      this.#rows.push(...batch);
    }
  }

  /**
   * Close the result set and its underlying cursor.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#cursorManager && this.#rpbId) {
      try {
        await this.#cursorManager.closeCursor(this.#rpbId);
      } catch { /* ignore close errors */ }
    }
  }
}
