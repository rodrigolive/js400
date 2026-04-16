/**
 * Statement lifecycle manager.
 *
 * Manages prepared statements, parameter binding, execution, and result sets.
 * Each prepared statement gets a unique RPB ID for server-side tracking.
 *
 * Upstream: JDStatement*.java, AS400JDBCPreparedStatement*.java
 * @module db/engine/StatementManager
 */

import { DBRequestDS, DescribeOption, StatementType, OpenAttributes, ORSBitmap } from '../protocol/DBRequestDS.js';
import {
  parseOperationReply, parseFetchReply, throwIfError,
  getCodePointData,
} from '../protocol/DBReplyDS.js';
import {
  parseColumnDescriptors, parseExtendedColumnDescriptors,
  parseBasicDataFormat, parseSuperExtendedDataFormat,
  getColumnByteLength,
} from '../protocol/DBDescriptors.js';
import { encodeValue, decodeResultData } from '../types/factory.js';

let rpbCounter = 0;

function stripLeadingComments(sql) {
  let text = String(sql ?? '').trimStart();

  while (text.length > 0) {
    if (text.startsWith('--')) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1).trimStart() : '';
      continue;
    }

    if (text.startsWith('/*')) {
      const end = text.indexOf('*/');
      text = end >= 0 ? text.slice(end + 2).trimStart() : '';
      continue;
    }

    break;
  }

  return text;
}

function inferStatementType(sql) {
  const text = stripLeadingComments(sql).toUpperCase();

  if (text.startsWith('SELECT')) return StatementType.SELECT;
  if (text.startsWith('CALL')) return StatementType.CALL;
  if (text.startsWith('COMMIT')) return StatementType.COMMIT;
  if (text.startsWith('ROLLBACK')) return StatementType.ROLLBACK;
  return StatementType.OTHER;
}

function isResizableParameterType(sqlType) {
  const absType = Math.abs(sqlType) & 0xFFFE;
  return absType === 448   // VARCHAR
      || absType === 456   // LONGVARCHAR
      || absType === 464   // VARGRAPHIC
      || absType === 472   // LONGGRAPHIC
      || absType === 908   // VARBINARY
      || absType === 404   // BLOB
      || absType === 408   // CLOB
      || absType === 412;  // DBCLOB
}

function nextRpbId() {
  rpbCounter = (rpbCounter + 1) & 0x7FFF;
  if (rpbCounter === 0) rpbCounter = 1;
  return rpbCounter;
}

/** Generate a unique prepared statement name for the server. */
function generateStatementName(rpbId) {
  return `STM${rpbId}`;
}

/** Generate a unique cursor name for the server. */
function generateCursorName(rpbId) {
  return `CRSR${rpbId}`;
}

export class StatementManager {
  #connection;
  #serverCCSID;
  #cursorManager;
  #statements;

  constructor(connection, cursorManager, opts = {}) {
    this.#connection = connection;
    this.#serverCCSID = opts.serverCCSID ?? 37;
    this.#cursorManager = cursorManager;
    this.#statements = new Map();
  }

  /**
   * Prepare a SQL statement with describe (get column/param metadata).
   * @param {string} sql
   * @returns {Promise<PreparedStatementHandle>}
   */
  async prepareStatement(sql) {
    const rpbId = nextRpbId();
    const cursorName = generateCursorName(rpbId);
    const statementName = generateStatementName(rpbId);
    const statementType = inferStatementType(sql);

    // Create RPB with cursor name + statement name (per jtopenlite)
    const createRpbBuf = DBRequestDS.buildCreateRPB({
      rpbId,
      cursorName,
      statementName,
    });
    const createReplyBuf = await this.#connection.sendAndReceive(createRpbBuf);
    const createReply = parseOperationReply(createReplyBuf, { serverCCSID: this.#serverCCSID });
    throwIfError(createReply.sqlca, 'Create RPB');

    // Prepare and describe with all required attributes (per jtopenlite)
    const prepBuf = DBRequestDS.buildPrepareAndDescribe({
      rpbId,
      sqlText: sql,
      statementName,
      statementType,
      prepareOption: 0,
      openAttributes: OpenAttributes.READ_ONLY,
      extendedColumnDescriptorOption: 0xF1,
      parameterMarkerFormat: true,
    });
    const prepReplyBuf = await this.#connection.sendAndReceive(prepBuf);
    const prepReply = parseOperationReply(prepReplyBuf, { serverCCSID: this.#serverCCSID });
    throwIfError(prepReply.sqlca, 'Prepare');

    // Parse column descriptors from the reply.
    // Server at DS level 0 returns basic format in CP 0x3805 (DATA_FORMAT).
    // Higher DS levels may return super extended format in CP 0x3812.
    let columnDescriptors = [];
    let paramDescriptors = [];

    const basicColData = getCodePointData(prepReply, 0x3805);
    if (basicColData && basicColData.length >= 8) {
      const parsed = parseBasicDataFormat(basicColData);
      columnDescriptors = parsed.descriptors;
    } else {
      const extDescData = getCodePointData(prepReply, 0x3812);
      if (extDescData && extDescData.length >= 16) {
        const parsed = parseSuperExtendedDataFormat(extDescData);
        columnDescriptors = parsed.descriptors;
      }
    }

    // Parse parameter marker descriptors from CP 0x3808 (basic format).
    let paramRecordSize = 0;
    let rawParamFormat = null;
    const basicParamData = getCodePointData(prepReply, 0x3808);
    if (basicParamData && basicParamData.length >= 8) {
      const parsed = parseBasicDataFormat(basicParamData);
      paramDescriptors = parsed.descriptors;
      paramRecordSize = parsed.recordSize;
      rawParamFormat = Buffer.from(basicParamData);
    }

    const stmt = {
      rpbId,
      sql,
      statementName,
      cursorName,
      columnDescriptors,
      paramDescriptors,
      paramRecordSize,
      rawParamFormat,
      paramCount: paramDescriptors.length,
      columnCount: columnDescriptors.length,
      descriptorHandle: 0,  // set at first execute via changeDescriptor
      // Widths last sent to the server via changeDescriptor. Used by
      // executeBatch to avoid a redundant changeDescriptor RTT when
      // successive batches have the same field widths.
      lastSentWidths: null,
      closed: false,
    };

    this.#statements.set(rpbId, stmt);
    return stmt;
  }

  /**
   * Execute a prepared statement.
   * For SELECT statements, opens a cursor and returns rows.
   * For DML statements, returns affected row count.
   *
   * @param {PreparedStatementHandle} stmt
   * @param {any[]} [params=[]]
   * @param {object} [opts={}]
   * @returns {Promise<ExecuteResult>}
   */
  async execute(stmt, params = [], opts = {}) {
    if (stmt.closed) throw new Error('Statement is closed');

    let parameterMarkerData = null;
    let activeParamDescriptors = stmt.paramDescriptors;
    if (params.length > 0 && stmt.paramDescriptors.length > 0) {
      const parameterPlan = this.#planParameterDescriptors(params, stmt.paramDescriptors);
      activeParamDescriptors = parameterPlan.descriptors;
      parameterMarkerData = this.#encodeParameters(params, activeParamDescriptors, parameterPlan.encodedValues);

      // Per JTOpen, parameter descriptors must match the actual bound widths.
      // Re-send the descriptor when parameters are present so LONGVARCHAR and
      // similar host-described max widths are shrunk to the value being sent.
      if (stmt.descriptorHandle === 0) {
        stmt.descriptorHandle = stmt.rpbId;
      }
      const cdBuf = DBRequestDS.buildChangeDescriptor({
        rpbId: stmt.rpbId,
        descriptorHandle: stmt.descriptorHandle,
        descriptors: activeParamDescriptors,
        recordSize: stmt.paramRecordSize,
      });
      const cdReplyBuf = await this.#connection.sendAndReceive(cdBuf);
      const cdReply = parseOperationReply(cdReplyBuf, { serverCCSID: this.#serverCCSID });
      throwIfError(cdReply.sqlca, 'Change descriptor');
    }

    // JTOpen uses separate function IDs for SELECT vs DML:
    // - OPEN_AND_DESCRIBE (0x1804) for SELECT (opens cursor)
    // - EXECUTE (0x1805) for DML (INSERT/UPDATE/DELETE)
    // It does NOT use EXECUTE_OR_OPEN_DESCRIBE (0x1812).
    const isSelect = stmt.columnDescriptors.length > 0;

    if (isSelect) {
      // SELECT: open cursor via OPEN_AND_DESCRIBE.
      // Pass BLOCKING_FACTOR so the server returns the first block of rows
      // inline with the open reply — saves 1 RTT per N rows. JTOpen does the
      // same by default (block size ~32KB worth of rows).
      const blockingFactor = opts.blockingFactor ?? 2048;
      const reqBuf = DBRequestDS.buildOpenAndDescribe({
        rpbId: stmt.rpbId,
        parameterMarkerData,
        pmDescriptorHandle: stmt.descriptorHandle ?? 0,
        openAttributes: 0x80,
        blockingFactor,
      });

      const replyBuf = await this.#connection.sendAndReceive(reqBuf);
      const reply = parseFetchReply(replyBuf, { serverCCSID: this.#serverCCSID });

      // SQLCODE 100 means end of data (no rows), not an error
      if (reply.sqlca.isError && reply.sqlca.sqlCode !== 100) {
        throwIfError(reply.sqlca, 'Open cursor');
      }

      // Register cursor for subsequent fetches
      this.#cursorManager.registerCursor(stmt.rpbId, stmt.columnDescriptors);

      // Decode any initial rows from 0x380E result data
      const rows = [];
      for (const dataBuf of reply.rowDataBuffers) {
        const decoded = decodeResultData(dataBuf, stmt.columnDescriptors, this.#serverCCSID);
        rows.push(...decoded);
      }

      return {
        hasResultSet: true,
        rows,
        affectedRows: reply.sqlca.rowCount,
        sqlca: reply.sqlca,
        rpbId: stmt.rpbId,
        endOfData: reply.endOfData,
        columnDescriptors: stmt.columnDescriptors,
        blockingFactor,
      };
    }

    // DML: use EXECUTE
    const reqBuf = DBRequestDS.buildExecute({
      rpbId: stmt.rpbId,
      parameterMarkerData,
      pmDescriptorHandle: stmt.descriptorHandle ?? 0,
    });

    const replyBuf = await this.#connection.sendAndReceive(reqBuf);
    const reply = parseOperationReply(replyBuf, { serverCCSID: this.#serverCCSID });
    throwIfError(reply.sqlca, 'Execute');

    return {
      hasResultSet: false,
      rows: [],
      affectedRows: reply.sqlca.rowCount,
      sqlca: reply.sqlca,
      rpbId: stmt.rpbId,
      endOfData: true,
      columnDescriptors: [],
    };
  }

  /**
   * Execute a batch of parameter sets in a single round trip per chunk.
   *
   * Per JTOpen AS400JDBCPreparedStatementImpl.executeBatch, N rows are
   * packed into one DBOriginalData (0x3811) code point with rowCount=N,
   * then sent in one EXECUTE (0x1805) request. The server returns a
   * single SQLCA whose rowCount is the total rows inserted across the
   * batch. This collapses 2N round trips (single-row path) into 2 per
   * chunk (changeDescriptor + execute).
   *
   * Batches larger than MAX_BLOCKED_ROWS are split into chunks, mirroring
   * JTOpen's getMaximumBlockedInputRows() 32_000-row cap.
   *
   * @param {PreparedStatementHandle} stmt
   * @param {any[][]} paramSets
   * @returns {Promise<{ affectedRows: number, sqlca: object, batchSize: number, isInsert: boolean }>}
   */
  async executeBatch(stmt, paramSets) {
    if (stmt.closed) throw new Error('Statement is closed');

    const batchSize = paramSets?.length ?? 0;
    if (batchSize === 0) {
      return { affectedRows: 0, sqlca: null, batchSize: 0, isInsert: false };
    }

    if (stmt.paramDescriptors.length === 0) {
      // No parameters — just execute once and ignore the "batch".
      const result = await this.execute(stmt, []);
      return {
        affectedRows: result.affectedRows,
        sqlca: result.sqlca,
        batchSize: 1,
        isInsert: inferStatementType(stmt.sql) === StatementType.OTHER,
      };
    }

    // Pre-encode every value once. We need the encoded buffers both to
    // size resizable (VARCHAR-family) columns and to pack the data block.
    // Memory: roughly paramSets.length × paramCount × avg 40 bytes.
    const paramCount = stmt.paramDescriptors.length;
    const encodedRows = new Array(batchSize);
    const nullRows = new Array(batchSize);

    // Track the widest encoded length per column for resizable types.
    // For fixed-width types this is unused.
    const maxFieldLen = new Array(paramCount).fill(0);
    const isResizable = new Array(paramCount);
    for (let c = 0; c < paramCount; c++) {
      isResizable[c] = isResizableParameterType(stmt.paramDescriptors[c].sqlType);
    }

    for (let r = 0; r < batchSize; r++) {
      const params = paramSets[r];
      const encoded = new Array(paramCount);
      const nulls = new Uint8Array(paramCount);
      for (let c = 0; c < paramCount; c++) {
        const v = params?.[c];
        if (v === null || v === undefined) {
          nulls[c] = 1;
          encoded[c] = null;
          continue;
        }
        const desc = stmt.paramDescriptors[c];
        const buf = encodeValue(v, desc, this.#serverCCSID);
        encoded[c] = buf;
        if (isResizable[c] && buf.length > maxFieldLen[c]) {
          maxFieldLen[c] = buf.length;
        }
      }
      encodedRows[r] = encoded;
      nullRows[r] = nulls;
    }

    // Build batch-width descriptors. For resizable columns, length is
    // max(encoded - 2) across the batch (2-byte length prefix). For
    // fixed columns, copy from the server descriptor.
    const batchDescriptors = new Array(paramCount);
    let paramRecordSize = 0;
    for (let c = 0; c < paramCount; c++) {
      const src = stmt.paramDescriptors[c];
      if (isResizable[c]) {
        // Cap at the server-described maximum; a VARCHAR(50) column
        // cannot accept a 51-byte value, but also never needs more.
        const serverMax = src.length;
        const wanted = Math.max(0, maxFieldLen[c] - 2);
        const chosen = Math.min(serverMax, wanted);
        batchDescriptors[c] = { ...src, length: chosen, rawFieldLength: 2 + chosen };
      } else {
        batchDescriptors[c] = src;
      }
      paramRecordSize += getColumnByteLength(batchDescriptors[c]);
    }

    // Send the change-descriptor only when widths actually change.
    // On subsequent batches with the same schema we can skip this RTT;
    // the server still remembers the widths from the previous batch.
    // For typical bulk inserts of fixed-width rows this saves one RTT
    // per chunk after the first.
    if (stmt.descriptorHandle === 0) {
      stmt.descriptorHandle = stmt.rpbId;
    }
    const widthsSig = batchDescriptors.map(d => d.length).join(',');
    if (stmt.lastSentWidths !== widthsSig) {
      const cdBuf = DBRequestDS.buildChangeDescriptor({
        rpbId: stmt.rpbId,
        descriptorHandle: stmt.descriptorHandle,
        descriptors: batchDescriptors,
        recordSize: paramRecordSize,
      });
      const cdReplyBuf = await this.#connection.sendAndReceive(cdBuf);
      const cdReply = parseOperationReply(cdReplyBuf, { serverCCSID: this.#serverCCSID });
      throwIfError(cdReply.sqlca, 'Change descriptor (batch)');
      stmt.lastSentWidths = widthsSig;
    }

    const isInsert = inferStatementType(stmt.sql) === StatementType.OTHER
      && /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*INSERT\b/i.test(stmt.sql);

    // JTOpen's getMaximumBlockedInputRows() caps batched inserts at
    // 32000 rows per request. Split large batches to match.
    const MAX_CHUNK = 32_000;
    let totalAffected = 0;
    let lastSqlca = null;

    for (let chunkStart = 0; chunkStart < batchSize; chunkStart += MAX_CHUNK) {
      const chunkEnd = Math.min(chunkStart + MAX_CHUNK, batchSize);
      const chunkRowCount = chunkEnd - chunkStart;

      const parameterMarkerData = this.#encodeParametersBatch(
        encodedRows, nullRows, batchDescriptors, chunkStart, chunkRowCount, paramRecordSize,
      );

      const reqBuf = DBRequestDS.buildExecute({
        rpbId: stmt.rpbId,
        parameterMarkerData,
        pmDescriptorHandle: stmt.descriptorHandle,
      });

      const replyBuf = await this.#connection.sendAndReceive(reqBuf);
      const reply = parseOperationReply(replyBuf, { serverCCSID: this.#serverCCSID });
      throwIfError(reply.sqlca, 'Execute (batch)');

      totalAffected += reply.sqlca.rowCount || 0;
      lastSqlca = reply.sqlca;
    }

    return {
      affectedRows: totalAffected,
      sqlca: lastSqlca,
      batchSize,
      isInsert,
    };
  }

  /**
   * Execute a SQL string immediately (no prepare step).
   * @param {string} sql
   * @returns {Promise<{ sqlca: object, affectedRows: number }>}
   */
  async executeImmediate(sql) {
    const rpbId = 0;
    const reqBuf = DBRequestDS.buildExecuteImmediate({ rpbId, sqlText: sql });
    const replyBuf = await this.#connection.sendAndReceive(reqBuf);
    const reply = parseOperationReply(replyBuf, { serverCCSID: this.#serverCCSID });
    throwIfError(reply.sqlca, 'Execute immediate');
    return { sqlca: reply.sqlca, affectedRows: reply.sqlca.rowCount };
  }

  /**
   * Fetch more rows from an open cursor.
   * @param {number} rpbId
   * @param {number} [count=100]
   * @returns {Promise<object[]>}
   */
  async fetch(rpbId, count = 100) {
    return this.#cursorManager.fetch(rpbId, count);
  }

  /**
   * Fetch all remaining rows.
   * @param {number} rpbId
   * @param {object} [opts]
   * @returns {Promise<object[]>}
   */
  async fetchAll(rpbId, opts) {
    return this.#cursorManager.fetchAll(rpbId, opts);
  }

  /**
   * Close a prepared statement and its cursor.
   * @param {PreparedStatementHandle} stmt
   */
  async closeStatement(stmt) {
    if (stmt.closed) return;

    try {
      await this.#cursorManager.closeCursor(stmt.rpbId);
    } catch { /* ignore */ }

    // Per JTOpen: delete descriptor handle before deleting RPB
    if (stmt.descriptorHandle) {
      try {
        const delDescBuf = DBRequestDS.buildDeleteDescriptor({
          rpbId: stmt.rpbId,
          descriptorHandle: stmt.descriptorHandle,
        });
        await this.#connection.sendAndReceive(delDescBuf);
      } catch { /* ignore */ }
    }

    try {
      const reqBuf = DBRequestDS.buildDeleteRPB({ rpbId: stmt.rpbId });
      await this.#connection.sendAndReceive(reqBuf);
    } catch { /* ignore */ }

    stmt.closed = true;
    this.#statements.delete(stmt.rpbId);
  }

  /**
   * Close all open statements.
   */
  async closeAll() {
    const stmts = [...this.#statements.values()];
    for (const stmt of stmts) {
      try {
        await this.closeStatement(stmt);
      } catch { /* ignore */ }
    }
  }

  /**
   * Encode parameter values into a DBOriginalData buffer for 0x3811.
   *
   * Per JTOpen DBOriginalData.java, the format is:
   *   Header (14 bytes):
   *     +0:  int32 consistencyToken (= 1)
   *     +4:  int32 rowCount
   *     +8:  int16 columnCount
   *     +10: int16 indicatorSize (= 2)
   *     +12: int16 rowSize (data bytes per row, NO indicators)
   *   Indicators section: rowCount × columnCount × indicatorSize bytes
   *     Each indicator is int16: 0=not-null, -1=null
   *   Data section: rowCount × rowSize bytes
   *     Field data packed per column (no indicators)
   *
   * @param {any[]} params
   * @param {object[]} descriptors
   * @returns {Buffer}
   */
  #planParameterDescriptors(params, descriptors) {
    const plannedDescriptors = descriptors.map(desc => ({ ...desc }));
    const encodedValues = new Array(plannedDescriptors.length).fill(null);

    for (let i = 0; i < plannedDescriptors.length; i++) {
      if (i >= params.length || params[i] == null) continue;

      const desc = plannedDescriptors[i];
      const encoded = encodeValue(params[i], desc, this.#serverCCSID);
      encodedValues[i] = encoded;

      if (!isResizableParameterType(desc.sqlType)) continue;

      const dataLength = Math.max(0, encoded.length - 2);
      plannedDescriptors[i] = {
        ...desc,
        length: dataLength,
        rawFieldLength: encoded.length,
      };
    }

    return {
      descriptors: plannedDescriptors,
      encodedValues,
    };
  }

  /**
   * Encode N rows of parameters into a single DBOriginalData buffer
   * (code point 0x3811). Mirrors the DBOriginalData header layout
   * from JTOpen:
   *
   *   Header (14 bytes):
   *     +0:  int32 consistencyToken (= 1)
   *     +4:  int32 rowCount
   *     +8:  int16 columnCount
   *     +10: int16 indicatorSize (= 2)
   *     +12: int16 rowSize          (data bytes per row, no indicators)
   *   Indicators: rowCount * columnCount * 2 bytes, row-major
   *     0 = value present, -1 (0xFFFF) = SQL NULL
   *   Data: rowCount * rowSize bytes
   *     Each row is a packed sequence of fixed-width fields, VARCHAR
   *     family columns written as 2-byte length prefix + data padded
   *     to the descriptor length.
   *
   * @param {Array<Buffer|null>[]} encodedRows - one inner array per row
   * @param {Uint8Array[]} nullRows - 1 = null column, 0 = value
   * @param {object[]} descriptors - batch-width descriptors
   * @param {number} rowStart - index into encodedRows for start of chunk
   * @param {number} rowCount - number of rows in this chunk
   * @param {number} rowSize - bytes per row (excluding indicators)
   * @returns {Buffer}
   */
  #encodeParametersBatch(encodedRows, nullRows, descriptors, rowStart, rowCount, rowSize) {
    const columnCount = descriptors.length;
    const indicatorSize = 2;
    const headerSize = 14;
    const indicatorBlockSize = rowCount * columnCount * indicatorSize;
    const dataBlockSize = rowCount * rowSize;
    const totalSize = headerSize + indicatorBlockSize + dataBlockSize;

    // allocUnsafe is safe here: the header, indicator block, and data
    // block are fully overwritten below. VARCHAR padding is written
    // explicitly (we zero the unused tail per field below).
    const buf = Buffer.allocUnsafe(totalSize);

    // Header
    buf.writeInt32BE(1, 0);                     // consistencyToken
    buf.writeInt32BE(rowCount, 4);              // rowCount
    buf.writeInt16BE(columnCount, 8);           // columnCount
    buf.writeInt16BE(indicatorSize, 10);        // indicatorSize
    buf.writeInt16BE(rowSize, 12);              // rowSize (data only)

    // Pre-compute per-column offsets within a row.
    const colOffsets = new Array(columnCount);
    const colByteLens = new Array(columnCount);
    let off = 0;
    for (let c = 0; c < columnCount; c++) {
      colOffsets[c] = off;
      const fieldLen = getColumnByteLength(descriptors[c]);
      colByteLens[c] = fieldLen;
      off += fieldLen;
    }

    const indicatorStart = headerSize;
    const dataStart = headerSize + indicatorBlockSize;

    for (let r = 0; r < rowCount; r++) {
      const srcRow = encodedRows[rowStart + r];
      const nulls = nullRows[rowStart + r];
      const indRowBase = indicatorStart + r * columnCount * indicatorSize;
      const rowDataBase = dataStart + r * rowSize;

      for (let c = 0; c < columnCount; c++) {
        const fieldLen = colByteLens[c];
        const fieldStart = rowDataBase + colOffsets[c];

        if (nulls[c]) {
          buf.writeInt16BE(-1, indRowBase + c * indicatorSize);
          // Zero the data slot so we don't leak allocUnsafe bytes.
          buf.fill(0, fieldStart, fieldStart + fieldLen);
          continue;
        }

        buf.writeInt16BE(0, indRowBase + c * indicatorSize);
        const encoded = srcRow[c];
        if (encoded.length >= fieldLen) {
          encoded.copy(buf, fieldStart, 0, fieldLen);
        } else {
          // Fixed-width field with a short encoded buffer: copy and
          // zero-pad the tail. For VARCHAR this is the normal case
          // (copy 2-byte length + data, pad remainder to desc.length).
          encoded.copy(buf, fieldStart, 0, encoded.length);
          buf.fill(0, fieldStart + encoded.length, fieldStart + fieldLen);
        }
      }
    }

    return buf;
  }

  #encodeParameters(params, descriptors, encodedValues = []) {
    const columnCount = descriptors.length;
    const indicatorSize = 2;
    const rowCount = 1;

    // Compute rowSize = sum of wire-level field lengths (no indicators)
    let rowSize = 0;
    for (const desc of descriptors) {
      rowSize += getColumnByteLength(desc);
    }

    const headerSize = 14;
    const indicatorBlockSize = rowCount * columnCount * indicatorSize;
    const dataBlockSize = rowCount * rowSize;
    const totalSize = headerSize + indicatorBlockSize + dataBlockSize;

    const buf = Buffer.alloc(totalSize);

    // Header
    buf.writeInt32BE(1, 0);                     // consistencyToken
    buf.writeInt32BE(rowCount, 4);              // rowCount
    buf.writeInt16BE(columnCount, 8);           // columnCount
    buf.writeInt16BE(indicatorSize, 10);        // indicatorSize
    buf.writeInt16BE(rowSize, 12);              // rowSize (data only)

    // Indicators section
    const indicatorStart = headerSize;
    for (let i = 0; i < columnCount; i++) {
      const isNull = i >= params.length || params[i] === null || params[i] === undefined;
      buf.writeInt16BE(isNull ? -1 : 0, indicatorStart + i * indicatorSize);
    }

    // Data section
    const dataStart = headerSize + indicatorBlockSize;
    let dataOffset = dataStart;
    for (let i = 0; i < columnCount; i++) {
      const desc = descriptors[i];
      const fieldLen = getColumnByteLength(desc);

      if (i < params.length && params[i] !== null && params[i] !== undefined) {
        const encoded = encodedValues[i] ?? encodeValue(params[i], desc, this.#serverCCSID);
        encoded.copy(buf, dataOffset, 0, Math.min(encoded.length, fieldLen));
      }
      // Null/unset values stay as zeros (already zero from alloc)
      dataOffset += fieldLen;
    }

    return buf;
  }

  get openStatementCount() {
    return this.#statements.size;
  }
}
