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
  SqlType,
} from '../protocol/DBDescriptors.js';
import { parsePackageInfo } from '../protocol/DBPackageInfo.js';
import { encodeValue, encodeValueInto, decodeResultData, getTypeHandler } from '../types/factory.js';
import { CharConverter } from '../../ccsid/CharConverter.js';

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
  let text = stripLeadingComments(sql).toUpperCase();
  // JDBC function-return form: `? = CALL FUNC(...)`. The leading `?=`
  // must not defeat CALL classification — otherwise the engine skips
  // ORS RESULT_DATA and the parameter-row decode, and the caller
  // silently gets no OUT / return value back. Strip it before the
  // keyword check.
  const retStripped = /^\?\s*=\s*/.exec(text);
  if (retStripped) text = text.slice(retStripped[0].length);

  if (text.startsWith('SELECT')) return StatementType.SELECT;
  if (text.startsWith('CALL')) return StatementType.CALL;
  if (text.startsWith('COMMIT')) return StatementType.COMMIT;
  if (text.startsWith('ROLLBACK')) return StatementType.ROLLBACK;
  return StatementType.OTHER;
}

function tokenizeSqlKeywords(sql) {
  const tokens = [];
  let token = '';
  let i = 0;
  const text = String(sql ?? '');

  const flush = () => {
    if (token.length > 0) {
      tokens.push(token.toUpperCase());
      token = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '-' && next === '-') {
      flush();
      i += 2;
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      flush();
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(i + 2, text.length);
      continue;
    }

    if (ch === '\'' || ch === '"') {
      flush();
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === quote) {
          if (text[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (/[A-Za-z0-9_$]/.test(ch)) {
      token += ch;
      i++;
      continue;
    }

    flush();
    i++;
  }

  flush();
  return tokens;
}

function isForUpdateSelect(sql) {
  if (inferStatementType(sql) !== StatementType.SELECT) return false;
  const tokens = tokenizeSqlKeywords(sql);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === 'FOR' && tokens[i + 1] === 'UPDATE') return true;
  }
  return false;
}

function getOpenAttributesForSql(sql) {
  return isForUpdateSelect(sql)
    ? OpenAttributes.ALL
    : OpenAttributes.READ_ONLY;
}

function containsLobDescriptors(descriptors) {
  for (const desc of descriptors || []) {
    const absType = Math.abs(desc.sqlType) & 0xFFFE;
    if (absType === SqlType.BLOB
      || absType === SqlType.CLOB
      || absType === SqlType.DBCLOB
      || absType === SqlType.BLOB_LOCATOR
      || absType === SqlType.CLOB_LOCATOR
      || absType === SqlType.DBCLOB_LOCATOR) {
      return true;
    }
  }
  return false;
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

/**
 * Exposed for callers (e.g. `DbConnection`) that need to reserve a
 * connection-level RPB id for operations that are NOT tied to a
 * specific prepared statement. Most notably the SQL package manager,
 * which mirrors JTOpen's `JDPackageManager` using the connection's
 * stable `id_` for CREATE_PACKAGE / RETURN_PACKAGE instead of borrowing
 * an in-flight prepare's handle.
 */
export function reserveConnectionRpbId() {
  return nextRpbId();
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
  #packageManager;

  constructor(connection, cursorManager, opts = {}) {
    this.#connection = connection;
    this.#serverCCSID = opts.serverCCSID ?? 37;
    this.#cursorManager = cursorManager;
    this.#statements = new Map();
    // PackageManager is a null reference until DbConnection wires one
    // in. Keeping it optional lets StatementManager stay testable in
    // isolation — tests that don't care about packages construct the
    // manager without a package reference.
    this.#packageManager = opts.packageManager ?? null;
    // JTOpen `holdStatements` → DB2 HOLD_INDICATOR (0x380F). When true,
    // prepared statements / cursors survive COMMIT so the cache isn't
    // invalidated on every transaction boundary. `null` leaves the
    // server on its default behavior (cursor closes at commit).
    this.defaultHoldIndicator = typeof opts.holdIndicator === 'number'
      ? opts.holdIndicator : null;

    // Plumbing-only performance knobs. Stored verbatim so a later
    // pass can wire wire-shape behavior behind them without churn.
    // Exposed for inspection (test harness, bench, future package
    // manager). Defaults are nullish — the fast path checks
    // `if (this.extendedDynamic)` and short-circuits.
    this.extendedDynamic = opts.extendedDynamic ?? null;
    this.packageCache = opts.packageCache ?? null;
    this.packageName = opts.packageName ?? null;
    this.packageLibrary = opts.packageLibrary ?? null;
    this.defaultBlockSizeKB = Number.isFinite(opts.blockSizeKB)
      ? opts.blockSizeKB
      : null;

    // Lightweight protocol-activity counters. Zero cost when unread.
    // Exposed via `metrics`; reset via `resetMetrics()`. Used by the
    // live benchmark to tie performance changes to real protocol
    // behavior (e.g., did a knob halve the fetch RTT count?).
    //
    // The package* counters live on the PackageManager itself so that
    // a single object owns the truth; we expose read-through getters
    // here so the bench harness and existing tests can keep reading
    // `statementManager.metrics.packageHits` unchanged.
    this.metrics = Object.defineProperties({
      prepareCalls: 0,        // StatementManager.prepareStatement
      executeCalls: 0,        // StatementManager.execute (inc. SELECT/DML/CALL)
      batchCalls: 0,          // StatementManager.executeBatch chunks
      closeStatementCalls: 0, // StatementManager.closeStatement
    }, {
      packageHits: {
        enumerable: true,
        get: () => this.#packageManager?.metrics.packageHits ?? 0,
      },
      packageCreates: {
        enumerable: true,
        get: () => this.#packageManager?.metrics.packageCreates ?? 0,
      },
      packageFetches: {
        enumerable: true,
        get: () => this.#packageManager?.metrics.packageFetches ?? 0,
      },
    });
  }

  resetMetrics() {
    this.metrics.prepareCalls = 0;
    this.metrics.executeCalls = 0;
    this.metrics.batchCalls = 0;
    this.metrics.closeStatementCalls = 0;
    if (this.#packageManager) {
      const m = this.#packageManager.metrics;
      m.packageHits = 0;
      m.packageCreates = 0;
      m.packageFetches = 0;
    }
  }

  /**
   * Prepare a SQL statement with describe (get column/param metadata).
   *
   * `opts.cursorName` (when non-empty) is sent to the server as the
   * RPB's cursor name instead of the auto-generated `CRSR<rpbId>`.
   * Required for positioned `UPDATE / DELETE WHERE CURRENT OF
   * <name>` so the server can resolve the user-named cursor across
   * a separate prepared statement.
   *
   * @param {string} sql
   * @param {object} [opts]
   * @param {string} [opts.cursorName] - explicit cursor name from
   *   `Statement.setCursorName()` / `PreparedStatement.setCursorName()`.
   * @returns {Promise<PreparedStatementHandle>}
   */
  async prepareStatement(sql, opts = {}) {
    this.metrics.prepareCalls++;
    const rpbId = nextRpbId();
    // Honor user-supplied cursor names for positioned UPDATE/DELETE.
    // When no name is given, fall back to the auto-generated value
    // so existing behavior (and the prepared-statement cache) is
    // unaffected on the fast path.
    const requestedCursor = opts && typeof opts.cursorName === 'string'
      ? opts.cursorName.trim() : '';
    const cursorName = requestedCursor.length > 0
      ? requestedCursor
      : generateCursorName(rpbId);
    const statementName = generateStatementName(rpbId);
    const statementType = inferStatementType(sql);
    const openAttributes = getOpenAttributesForSql(sql);

    // SQL package lazy-create. When `extendedDynamic` is on and the
    // user supplied a package name, we materialize the server-side
    // package once per connection (JTOpen does the same in
    // AS400JDBCStatement.commonPrepare: `if (!packageManager_.isCreated())
    // packageManager_.create()`). Failure flips the manager to
    // disabled and — depending on the `packageError` policy —
    // either throws, queues a connection warning, or stays silent;
    // in all non-throwing cases the prepare itself proceeds on the
    // normal (packageless) path, matching JTOpen.
    const pkg = this.#packageManager;
    if (pkg && pkg.isEnabled() && !pkg.isCreated()) {
      await this.#ensurePackageCreated(pkg);
    }

    // Create RPB with cursor name + statement name (per jtopenlite).
    // Thread the connection-level HOLD_INDICATOR when the user asked
    // for holdStatements=true, so cursors survive COMMIT without a
    // reprepare round-trip.
    const rpbLibraryName = pkg && pkg.isEnabled()
      ? pkg.getLibraryName()
      : undefined;
    const createRpbBuf = DBRequestDS.buildCreateRPB({
      rpbId,
      cursorName,
      statementName,
      identifierCcsid: this.#serverCCSID,
      libraryName: rpbLibraryName,
      openAttributes,
      holdIndicator: this.defaultHoldIndicator ?? undefined,
    });
    const createReplyBuf = await this.#connection.sendAndReceive(createRpbBuf);
    const createReply = parseOperationReply(createReplyBuf, { serverCCSID: this.#serverCCSID });
    throwIfError(createReply.sqlca, 'Create RPB');

    // Resolve extended-dynamic package binding for this specific
    // prepare. When the manager is enabled AND the statement is
    // packageable, JTOpen sends PACKAGE_NAME (0x3804) alongside a
    // prepareOption=1 ("enhanced" prepare, which hints that the server
    // may look up / store a cached plan in the package). The library
    // is already bound on CREATE_RPB, so the prepare only carries
    // PACKAGE_NAME. When the manager is enabled but THIS statement is
    // unpackageable, JTOpen sends an empty PACKAGE_NAME codepoint; we
    // mirror that with `packageName: null`.
    let packageName;
    let prepareOption = 0;
    let cachedEntry = null;
    if (pkg && pkg.isEnabled()) {
      if (pkg.isPackaged(sql)) {
        packageName = pkg.getName();
        prepareOption = 1;
        if (pkg.isCached()) {
          cachedEntry = pkg.lookup(sql);
          const cachedColumns = cachedEntry?.resultDataFormat?.descriptors ?? [];
          const cachedParams = cachedEntry?.parameterMarkerFormat?.descriptors ?? [];
          if (cachedEntry && (containsLobDescriptors(cachedColumns) || containsLobDescriptors(cachedParams))) {
            cachedEntry = null;
          }
        }
      } else {
        packageName = null;
      }
    }

    let columnDescriptors = [];
    let paramDescriptors = [];
    let paramRecordSize = 0;
    let rawParamFormat = null;
    let statementNameOverride = null;

    if (!cachedEntry) {
      // Prepare and describe with all required attributes (per jtopenlite)
      const prepBuf = DBRequestDS.buildPrepareAndDescribe({
        rpbId,
        sqlText: sql,
        statementName,
        identifierCcsid: this.#serverCCSID,
        statementType,
        prepareOption,
        openAttributes,
        extendedColumnDescriptorOption: 0xF1,
        parameterMarkerFormat: true,
        packageName,
      });
      const prepReplyBuf = await this.#connection.sendAndReceive(prepBuf);
      const prepReply = parseOperationReply(prepReplyBuf, { serverCCSID: this.#serverCCSID });
      throwIfError(prepReply.sqlca, 'Prepare');

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

      const basicParamData = getCodePointData(prepReply, 0x3808);
      if (basicParamData && basicParamData.length >= 8) {
        const parsed = parseBasicDataFormat(basicParamData);
        paramDescriptors = parsed.descriptors;
        paramRecordSize = parsed.recordSize;
        rawParamFormat = Buffer.from(basicParamData);
      }
    } else {
      statementNameOverride = cachedEntry.statementName || null;
      columnDescriptors = cachedEntry.resultDataFormat?.descriptors ?? [];
      paramDescriptors = cachedEntry.parameterMarkerFormat?.descriptors ?? [];
      paramRecordSize = cachedEntry.parameterMarkerFormat?.recordSize ?? 0;
      rawParamFormat = null; // Reconstructed from descriptors on first execute
      pkg.recordHit();
    }

    const stmt = {
      rpbId,
      sql,
      statementName,
      statementNameOverride,
      cursorName,
      openAttributes,
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
      // Package binding context for the execution path. Packaged
      // statements always send PACKAGE_NAME. Only cache hits send the
      // name override, matching JTOpen's `nameOverride_`.
      packageName: packageName ?? null,
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
    this.metrics.executeCalls++;

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
      //
      // js400 intentionally keeps the default read-only SELECT path on the
      // pure open + later FETCH flow, even for read-only cursors. A live-host
      // qualification pass against a live IBM i host showed that requesting inline first
      // block data with OPEN_DESCRIBE_FETCH (0x180E) produced empty or
      // corrupted singleton/catalog rows on real IBM i queries, while plain
      // OPEN_AND_DESCRIBE (0x1804) followed by FETCH returned correct data.
      //
      // Keep `requestResultData` off until the 0x180E path is fully qualified
      // against live hosts. This preserves correctness without a measurable
      // performance loss in the current bench, because the existing benchmark
      // was already paying the same FETCH round-trips.
      const isReadOnlyCursor = (stmt.openAttributes ?? OpenAttributes.READ_ONLY)
        === OpenAttributes.READ_ONLY;
      const blockingFactor = isReadOnlyCursor
        ? (
            opts.blockingFactor
            ?? this.#computeBlockSizeRows(stmt.columnDescriptors, stmt.openAttributes)
            ?? 2048
          )
        : 1;
      const requestResultData = false;
      const reqBuf = DBRequestDS.buildOpenAndDescribe({
        rpbId: stmt.rpbId,
        parameterMarkerData,
        pmDescriptorHandle: stmt.descriptorHandle ?? 0,
        identifierCcsid: this.#serverCCSID,
        openAttributes: stmt.openAttributes ?? OpenAttributes.READ_ONLY,
        blockingFactor,
        requestResultData,
        // JTOpen nameOverride_ is only sent when the package cache
        // resolved the statement by name; normal packaged prepares
        // do not echo the statement name back here.
        statementName: stmt.statementNameOverride ?? undefined,
        packageName: stmt.packageName ?? undefined,
      });

      const replyBuf = await this.#connection.sendAndReceive(reqBuf);
      const reply = parseFetchReply(replyBuf, { serverCCSID: this.#serverCCSID });

      // SQLCODE 100 means end of data (no rows), not an error
      if (reply.sqlca.isError && reply.sqlca.sqlCode !== 100) {
        throwIfError(reply.sqlca, 'Open cursor');
      }

      // Prefer the open reply's row format over the stale PREPARE descriptors.
      // Even on the pure-open path the host can refine the row format at open
      // time (for example, metadata queries may widen names / labels), so the
      // cursor must fetch with the open-time descriptors, not the PREPARE-time
      // guess.
      let openColumnDescriptors = stmt.columnDescriptors;
      const basicFormats = reply.codePoints.get(0x3805) || [];
      const extFormats = reply.codePoints.get(0x3812) || [];
      if (extFormats.length > 0) {
        try {
          openColumnDescriptors = parseSuperExtendedDataFormat(extFormats[0]).descriptors;
        } catch {
          openColumnDescriptors = stmt.columnDescriptors;
        }
      } else if (basicFormats.length > 0) {
        try {
          openColumnDescriptors = parseBasicDataFormat(basicFormats[0]).descriptors;
        } catch {
          openColumnDescriptors = stmt.columnDescriptors;
        }
      }
      stmt.columnDescriptors = openColumnDescriptors;

      // Register cursor for subsequent fetches
      this.#cursorManager.registerCursor(stmt.rpbId, openColumnDescriptors);

      // No inline rows are requested on the default path above, so `rows`
      // stays empty and the first `ResultSet.next()` / `toArray()` call will
      // issue FETCH. The loop is kept so a future re-qualified prefetch path
      // can reuse the same decode logic.
      const rows = [];
      for (const dataBuf of reply.rowDataBuffers) {
        const decoded = decodeResultData(dataBuf, openColumnDescriptors, this.#serverCCSID);
        rows.push(...decoded);
      }

      return {
        hasResultSet: true,
        rows,
        affectedRows: reply.sqlca.rowCount,
        sqlca: reply.sqlca,
        rpbId: stmt.rpbId,
        endOfData: reply.endOfData,
        columnDescriptors: openColumnDescriptors,
        defaultFetchRows: this.#computeBlockSizeRows(
          openColumnDescriptors,
          stmt.openAttributes,
        ),
        blockingFactor,
      };
    }

    // DML or CALL: use EXECUTE.
    //
    // For CALL statements with parameter markers, request the parameter
    // row in the reply (ORS RESULT_DATA) and decode OUT/INOUT values from
    // code point 0x380E using the parameter descriptors. This mirrors
    // JTOpen AS400JDBCCallableStatement which reads `reply.getResultData()`
    // into `parameterRow_` and exposes OUT values through the standard
    // getters. SELECT / DML paths remain unchanged — the extra bit and
    // decode cost only applies to CALL.
    const isCall = inferStatementType(stmt.sql) === StatementType.CALL;
    const requestOutputData = isCall && activeParamDescriptors.length > 0;

    const reqBuf = DBRequestDS.buildExecute({
      rpbId: stmt.rpbId,
      parameterMarkerData,
      pmDescriptorHandle: stmt.descriptorHandle ?? 0,
      requestOutputData,
      identifierCcsid: this.#serverCCSID,
      // JTOpen nameOverride_ — only the cache-hit path sends the
      // prepared statement name on EXECUTE.
      statementName: stmt.statementNameOverride ?? undefined,
      packageName: stmt.packageName ?? undefined,
    });

    const replyBuf = await this.#connection.sendAndReceive(reqBuf);

    if (requestOutputData) {
      const reply = parseFetchReply(replyBuf, { serverCCSID: this.#serverCCSID });
      if (reply.sqlca.isError && reply.sqlca.sqlCode !== 100) {
        throwIfError(reply.sqlca, 'Execute CALL');
      }
      let parameterRow = null;
      if (reply.rowDataBuffers.length > 0) {
        const decoded = decodeResultData(
          reply.rowDataBuffers[0], activeParamDescriptors, this.#serverCCSID,
        );
        if (decoded.length > 0) parameterRow = decoded[0];
      }

      // Secondary 0x380E blocks in a CALL reply are the rows of
      // additional result sets the procedure opened (DECLARE CURSOR
      // + OPEN). The server typically inlines a descriptor (0x3805
      // or 0x3812) per result set alongside the data block. We pair
      // each tail buffer with the i-th available descriptor to
      // surface ONE GROUP PER RESULT SET instead of merging them
      // into a single flat list. When no descriptor is available
      // for a tail buffer, we preserve it as raw bytes so a higher
      // layer that knows the shape out-of-band can still decode it.
      //
      // `resultSetGroups` is the new authoritative shape;
      // `resultSetRows` / `resultSetDescriptors` / `extraResultBuffers`
      // remain populated from the *first* group for backward
      // compatibility with callers that haven't moved over.
      const resultSetGroups = [];
      let resultSetRows = null;
      let resultSetDescriptors = null;
      let extraResultBuffers = null;
      if (reply.rowDataBuffers.length > 1) {
        const tail = reply.rowDataBuffers.slice(1);
        const basicFormats = reply.codePoints.get(0x3805) || [];
        const superExtFormats = reply.codePoints.get(0x3812) || [];

        // Pre-parse all descriptors once so each tail buffer's
        // pairing is O(1).
        const decodedFormats = [];
        for (const buf of basicFormats) {
          if (buf && buf.length >= 8) {
            decodedFormats.push(parseBasicDataFormat(buf).descriptors);
          }
        }
        for (const buf of superExtFormats) {
          if (buf && buf.length >= 16) {
            decodedFormats.push(parseSuperExtendedDataFormat(buf).descriptors);
          }
        }

        const tailExtras = [];
        for (let i = 0; i < tail.length; i++) {
          const buf = tail[i];
          // Prefer an i-aligned descriptor; fall back to the first
          // one when the server sent fewer descriptors than blocks
          // (best effort — better than losing rows).
          let descriptors = decodedFormats[i] || decodedFormats[0] || null;
          if (descriptors && descriptors.length > 0) {
            const rows = decodeResultData(buf, descriptors, this.#serverCCSID);
            resultSetGroups.push({ rows, descriptors });
          } else {
            tailExtras.push(buf);
            resultSetGroups.push({ __raw: buf });
          }
        }
        // Backward-compat surface from the first group.
        const first = resultSetGroups[0];
        if (first?.rows) {
          resultSetRows = first.rows;
          resultSetDescriptors = first.descriptors;
        }
        if (tailExtras.length > 0) extraResultBuffers = tailExtras;
      }
      return {
        hasResultSet: false,
        rows: [],
        affectedRows: reply.sqlca.rowCount,
        sqlca: reply.sqlca,
        rpbId: stmt.rpbId,
        endOfData: true,
        columnDescriptors: [],
        parameterRow,
        parameterDescriptors: activeParamDescriptors,
        resultSetGroups,
        resultSetRows,
        resultSetDescriptors,
        extraResultBuffers,
      };
    }

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
    this.metrics.batchCalls++;

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

    const paramCount = stmt.paramDescriptors.length;
    const ccsid = this.#serverCCSID;

    // Classify each column once: resizable? CCSID? This drives the width
    // computation without re-parsing the sqlType per row.
    const isResizable = new Array(paramCount);
    const colCcsid = new Array(paramCount);
    for (let c = 0; c < paramCount; c++) {
      const d = stmt.paramDescriptors[c];
      isResizable[c] = isResizableParameterType(d.sqlType);
      colCcsid[c] = d.ccsid || ccsid;
    }

    // Pass 1: determine per-column width for resizable types. We do
    // this WITHOUT fully encoding — for single-byte CCSIDs (the a live IBM i host
    // default CCSID 37 case), byte length equals char length, so a
    // plain `String(v).length` scan suffices. For UTF-8 we delegate to
    // Buffer.byteLength, and for UTF-16 it's 2 × char count.
    //
    // This avoids the per-field Buffer allocation storm in the prior
    // implementation (4K rows × 35 cols ≈ 140K Buffer allocations per
    // chunk) — the single biggest source of GC pressure in the hot path.
    const maxFieldDataLen = new Array(paramCount).fill(0);
    let hasAnyResizable = false;
    for (let c = 0; c < paramCount; c++) {
      if (isResizable[c]) { hasAnyResizable = true; break; }
    }
    if (hasAnyResizable) {
      for (let r = 0; r < batchSize; r++) {
        const params = paramSets[r];
        if (!params) continue;
        for (let c = 0; c < paramCount; c++) {
          if (!isResizable[c]) continue;
          const v = params[c];
          if (v === null || v === undefined) continue;
          const s = typeof v === 'string' ? v : String(v);
          let bl;
          if (colCcsid[c] === 1208) {
            bl = Buffer.byteLength(s, 'utf8');
          } else if (colCcsid[c] === 1200 || colCcsid[c] === 13488 || colCcsid[c] === 61952) {
            bl = s.length * 2;
          } else {
            bl = s.length; // single-byte EBCDIC / binary
          }
          if (bl > maxFieldDataLen[c]) maxFieldDataLen[c] = bl;
        }
      }
    }

    // Build batch-width descriptors. Resizable columns shrink to the
    // widest observed value (clamped to server-described max).
    const batchDescriptors = new Array(paramCount);
    let paramRecordSize = 0;
    for (let c = 0; c < paramCount; c++) {
      const src = stmt.paramDescriptors[c];
      if (isResizable[c]) {
        const serverMax = src.length;
        const chosen = Math.min(serverMax, maxFieldDataLen[c]);
        batchDescriptors[c] = { ...src, length: chosen, rawFieldLength: 2 + chosen };
      } else {
        batchDescriptors[c] = src;
      }
      paramRecordSize += getColumnByteLength(batchDescriptors[c]);
    }

    // Send the change-descriptor only when widths actually change.
    // On subsequent batches with the same schema we can skip this RTT.
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

    // DBOriginalData layout constants (see #encodeParametersBatchInto).
    const DBOD_HEADER_SIZE = 14;
    const INDICATOR_SIZE = 2;

    const prof = StatementManager._batchProfile;
    for (let chunkStart = 0; chunkStart < batchSize; chunkStart += MAX_CHUNK) {
      const chunkEnd = Math.min(chunkStart + MAX_CHUNK, batchSize);
      const chunkRowCount = chunkEnd - chunkStart;

      // Size of the 0x3811 DBOriginalData content (header + indicators + data)
      const indicatorBlockSize = chunkRowCount * paramCount * INDICATOR_SIZE;
      const dataBlockSize = chunkRowCount * paramRecordSize;
      const paramDataSize = DBOD_HEADER_SIZE + indicatorBlockSize + dataBlockSize;

      const tEnc0 = prof ? performance.now() : 0;
      // Allocate the FINAL packet up-front; reserve the DBOriginalData
      // region and fill it directly. No intermediate parameterMarkerData
      // buffer, no double memcopy.
      const { buffer: reqBuf, paramDataOffset } = DBRequestDS.buildExecuteInPlace({
        rpbId: stmt.rpbId,
        pmDescriptorHandle: stmt.descriptorHandle,
        parameterMarkerDataSize: paramDataSize,
        rleRequestCompression: true,
        rleReplyCompression: true,
      });

      this.#encodeParametersBatchInto(
        paramSets, batchDescriptors, chunkStart, chunkRowCount, paramRecordSize,
        reqBuf, paramDataOffset,
      );

      // Try RLE compression: for CHAR-heavy batch data (lots of 0x40
      // EBCDIC spaces and zero padding), this typically shrinks the
      // wire packet 3-5x, dramatically reducing send time on limited
      // uplinks.
      const sendBuf = DBRequestDS.compressRequestInPlace(reqBuf);
      if (prof) prof.encodeMs += performance.now() - tEnc0;

      const tNet0 = prof ? performance.now() : 0;
      const replyBuf = await this.#connection.sendAndReceive(sendBuf);
      if (prof) {
        prof.netMs += performance.now() - tNet0;
        prof.packetBytes += sendBuf.length;
        prof.rowCount += chunkRowCount;
      }
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

    // Lazy CREATE_PACKAGE on the immediate path too. JTOpen attaches
    // package codepoints to FUNCTIONID_EXECUTE_IMMEDIATE in
    // `AS400JDBCStatement.commonPrepare` → immediate branch when the
    // package manager is enabled, so the server can stash
    // packageable statements that arrive via executeImmediate as
    // well as prepareStatement. Without this hook, the two entry
    // points would disagree on package state.
    const pkg = this.#packageManager;
    if (pkg && pkg.isEnabled() && !pkg.isCreated()) {
      await this.#ensurePackageCreated(pkg);
    }

    let packageName;
    let prepareOption;
    let statementType;
    if (pkg && pkg.isEnabled()) {
      if (pkg.isPackaged(sql)) {
        packageName = pkg.getName();
        prepareOption = 1;
      } else {
        packageName = null;
        prepareOption = 0;
      }
      statementType = inferStatementType(sql);
    }

    const reqBuf = DBRequestDS.buildExecuteImmediate({
      rpbId,
      sqlText: sql,
      identifierCcsid: this.#serverCCSID,
      packageName,
      prepareOption,
      statementType,
    });
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
    this.metrics.closeStatementCalls++;

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
  /**
   * Zero-copy batch encoder. Writes the DBOriginalData code-point
   * content (header + indicators + data) directly into the caller's
   * `buf` starting at `baseOffset`. No intermediate buffer is
   * allocated — this mirrors JTOpen's pattern of writing parameter
   * bytes straight into the request datastream's backing byte array.
   *
   * Caller is responsible for pre-sizing `buf` to hold at least
   * `14 + rowCount*columnCount*2 + rowCount*rowSize` bytes starting
   * at `baseOffset`.
   *
   * @param {any[][]} paramSets - caller's parameter rows (not pre-encoded)
   * @param {object[]} descriptors - batch-width descriptors
   * @param {number} rowStart
   * @param {number} rowCount
   * @param {number} rowSize - bytes per row (excluding indicators)
   * @param {Buffer} buf - destination (packet) buffer
   * @param {number} baseOffset - byte offset in `buf` where DBOriginalData starts
   */
  #encodeParametersBatchInto(paramSets, descriptors, rowStart, rowCount, rowSize, buf, baseOffset) {
    const columnCount = descriptors.length;
    const indicatorSize = 2;
    const headerSize = 14;
    const indicatorBlockSize = rowCount * columnCount * indicatorSize;

    // DBOriginalData header (14 bytes) at baseOffset
    buf.writeInt32BE(1, baseOffset);                     // consistencyToken
    buf.writeInt32BE(rowCount, baseOffset + 4);          // rowCount
    buf.writeInt16BE(columnCount, baseOffset + 8);       // columnCount
    buf.writeInt16BE(indicatorSize, baseOffset + 10);    // indicatorSize
    buf.writeInt16BE(rowSize, baseOffset + 12);          // rowSize (data only)

    // Pre-resolve per-column state once per chunk:
    //   - field offset / length within a row
    //   - a specialized encoder closure that captures the type handler,
    //     CCSID converter table, and column width
    // This eliminates the ~7M Map.get calls per 200K-row load run that
    // the generic `encodeValueInto` -> `getTypeHandler` -> `CharConverter`
    // path would incur, and lets V8 inline the hot cases.
    const colOffsets = new Array(columnCount);
    const colEncoders = new Array(columnCount);
    let off = 0;
    for (let c = 0; c < columnCount; c++) {
      colOffsets[c] = off;
      const desc = descriptors[c];
      const fieldLen = getColumnByteLength(desc);
      off += fieldLen;
      colEncoders[c] = this.#makeColumnEncoder(desc, fieldLen);
    }

    const indicatorStart = baseOffset + headerSize;
    const dataStart = baseOffset + headerSize + indicatorBlockSize;

    for (let r = 0; r < rowCount; r++) {
      const params = paramSets[rowStart + r];
      const indRowBase = indicatorStart + r * columnCount * indicatorSize;
      const rowDataBase = dataStart + r * rowSize;

      for (let c = 0; c < columnCount; c++) {
        const fieldStart = rowDataBase + colOffsets[c];
        const indOff = indRowBase + c * indicatorSize;
        const v = params ? params[c] : undefined;

        if (v === null || v === undefined) {
          // NULL: indicator = -1 (0xFFFF). Encoder is still called to
          // zero-fill the data slot and avoid leaking allocUnsafe bytes.
          buf[indOff] = 0xFF;
          buf[indOff + 1] = 0xFF;
          colEncoders[c](null, buf, fieldStart);
          continue;
        }

        // NOT NULL: indicator = 0
        buf[indOff] = 0x00;
        buf[indOff + 1] = 0x00;
        colEncoders[c](v, buf, fieldStart);
      }
    }
  }

  /**
   * Build a specialized encoder closure for one column that writes a
   * field value directly into a Buffer at a given offset. The closure
   * captures per-column state (fieldLen, CCSID table, type handler) so
   * the hot loop in `#encodeParametersBatchInto` does zero Map lookups
   * per field.
   *
   * Specialized inline paths (no function call into a type handler):
   *   - VARCHAR + single-byte EBCDIC (e.g. CCSID 37, 500, 280)
   *   - CHAR    + single-byte EBCDIC
   *   - INTEGER, SMALLINT, BIGINT
   *   - FLOAT (REAL and DOUBLE)
   *
   * Other types fall back to `handler.encodeInto` captured in the
   * closure, avoiding the Map.get on each call but still paying one
   * function call.
   *
   * @returns {(value: any, buf: Buffer, offset: number) => void}
   */
  #makeColumnEncoder(desc, fieldLen) {
    const ccsid = desc.ccsid || this.#serverCCSID;
    const absType = Math.abs(desc.sqlType) & 0xFFFE;
    const maxLen = desc.length;

    const isSingleByteCcsid = ccsid !== 1208 && ccsid !== 1200
      && ccsid !== 13488 && ccsid !== 61952 && ccsid !== 65535;

    // ---- VARCHAR / LONGVARCHAR, single-byte EBCDIC ----
    // Hot path for the typical IBM i insert: VARCHAR columns on CCSID 37.
    // Writes [ui16 actualLen][data...][zero pad to fieldLen-2-actualLen].
    if ((absType === 448 || absType === 456) && isSingleByteCcsid) {
      let table;
      try {
        table = CharConverter.getConverter(ccsid).fromUnicodeTable;
      } catch {
        table = null;
      }
      if (table) {
        return (v, buf, offset) => {
          if (v === null || v === undefined) {
            buf.fill(0, offset, offset + fieldLen);
            return;
          }
          const s = typeof v === 'string' ? v : String(v);
          const n = s.length < maxLen ? s.length : maxLen;
          const base = offset + 2;
          for (let i = 0; i < n; i++) {
            buf[base + i] = table[s.charCodeAt(i)] || 0x3F;
          }
          buf[offset] = (n >> 8) & 0xFF;
          buf[offset + 1] = n & 0xFF;
          const padStart = base + n;
          const padEnd = offset + fieldLen;
          if (padEnd > padStart) buf.fill(0, padStart, padEnd);
        };
      }
    }

    // ---- CHAR, single-byte EBCDIC ----
    if (absType === 452 && isSingleByteCcsid) {
      let table;
      try {
        table = CharConverter.getConverter(ccsid).fromUnicodeTable;
      } catch {
        table = null;
      }
      if (table) {
        return (v, buf, offset) => {
          if (v === null || v === undefined) {
            buf.fill(0, offset, offset + fieldLen);
            return;
          }
          const s = typeof v === 'string' ? v : String(v);
          const n = s.length < maxLen ? s.length : maxLen;
          for (let i = 0; i < n; i++) {
            buf[offset + i] = table[s.charCodeAt(i)] || 0x3F;
          }
          if (n < maxLen) buf.fill(0x40, offset + n, offset + maxLen);
        };
      }
    }

    // ---- INTEGER ----
    if (absType === 496) {
      return (v, buf, offset) => {
        if (v === null || v === undefined) {
          buf.fill(0, offset, offset + 4);
          return;
        }
        buf.writeInt32BE(Number(v) | 0, offset);
      };
    }

    // ---- SMALLINT ----
    if (absType === 500) {
      return (v, buf, offset) => {
        if (v === null || v === undefined) {
          buf[offset] = 0;
          buf[offset + 1] = 0;
          return;
        }
        buf.writeInt16BE(Number(v) | 0, offset);
      };
    }

    // ---- BIGINT ----
    if (absType === 492) {
      return (v, buf, offset) => {
        if (v === null || v === undefined) {
          buf.fill(0, offset, offset + 8);
          return;
        }
        buf.writeBigInt64BE(BigInt(v), offset);
      };
    }

    // ---- FLOAT (REAL or DOUBLE, chosen by desc.length) ----
    if (absType === 480) {
      if (desc.length === 4) {
        return (v, buf, offset) => {
          if (v === null || v === undefined) {
            buf.fill(0, offset, offset + 4);
            return;
          }
          buf.writeFloatBE(Number(v), offset);
        };
      }
      return (v, buf, offset) => {
        if (v === null || v === undefined) {
          buf.fill(0, offset, offset + 8);
          return;
        }
        buf.writeDoubleBE(Number(v), offset);
      };
    }

    // ---- Fallback: capture handler.encodeInto in the closure ----
    const handler = getTypeHandler(desc.sqlType);
    if (handler && handler.encodeInto) {
      const encodeInto = handler.encodeInto;
      const serverCcsid = this.#serverCCSID;
      return (v, buf, offset) => {
        if (v === null || v === undefined) {
          buf.fill(0, offset, offset + fieldLen);
          return;
        }
        encodeInto(v, buf, offset, fieldLen, desc, serverCcsid);
      };
    }

    // Last-resort fallback: the generic dispatcher (still only 1 Map.get
    // per call, but no pre-resolution possible here).
    const serverCcsid = this.#serverCCSID;
    return (v, buf, offset) => {
      if (v === null || v === undefined) {
        buf.fill(0, offset, offset + fieldLen);
        return;
      }
      encodeValueInto(v, buf, offset, fieldLen, desc, serverCcsid);
    };
  }

  #computeBlockSizeRows(descriptors, openAttributes) {
    if (this.defaultBlockSizeKB == null) return null;
    if ((openAttributes ?? OpenAttributes.READ_ONLY) !== OpenAttributes.READ_ONLY) {
      return 1;
    }

    let rowLength = 0;
    for (const desc of descriptors || []) {
      rowLength += getColumnByteLength(desc);
    }
    if (rowLength <= 0) return 1;

    let rows = Math.floor((this.defaultBlockSizeKB * 1024) / rowLength);
    if (rows > 32767) rows = 32767;
    if (rows <= 1) rows = 1;
    return rows;
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

  /**
   * Execute CREATE PACKAGE once per connection. Called lazily from
   * `prepareStatement` / `executeImmediate` on the first eligible
   * call with a package-enabled manager. Mirrors
   * `JDPackageManager.create`:
   *
   *   - SQLCODE/returnCode  0     → fresh create, mark created
   *   - SQLCODE -601              → package already exists, still
   *                                 counts as created (same as JTOpen)
   *   - anything else             → report failure via packageError
   *                                 policy (none/warning/exception)
   *                                 and disable the manager; for
   *                                 warning/none paths subsequent
   *                                 prepares fall back to the
   *                                 packageless path.
   *
   * Uses the connection-scoped RPB id from the PackageManager itself
   * (mirroring JTOpen's connection `id_`) — NOT the per-statement
   * rpbId. Reusing an in-flight prepare's handle would conflate
   * package identity with statement identity on live servers.
   *
   * After a successful create we optionally issue RETURN_PACKAGE when
   * the user asked for `packageCache`. The reply blob is decoded into
   * per-statement cache metadata for the skip-prepare path. Live-host
   * qualification is still pending, but the local wiring is active.
   */
  async #ensurePackageCreated(pkg) {
    const rpbId = pkg.rpbId;
    try {
      const reqBuf = DBRequestDS.buildCreatePackage({
        rpbId,
        packageName: pkg.getName(),
        packageLibrary: pkg.getLibraryName(),
        identifierCcsid: this.#serverCCSID,
      });
      const replyBuf = await this.#connection.sendAndReceive(reqBuf);
      const reply = parseOperationReply(replyBuf, { serverCCSID: this.#serverCCSID });
      const sqlca = reply.sqlca;
      // JTOpen treats SQLCODE -601 as "already exists" — same
      // result from our POV (the server-side package is ready for
      // subsequent prepares).
      if (sqlca && sqlca.isError && sqlca.sqlCode !== -601) {
        // `reportFailure` throws for exception policy, so the
        // return-line below runs only on warning/none.
        pkg.reportFailure(
          `CREATE PACKAGE failed: SQLCODE ${sqlca.sqlCode} SQLSTATE ${sqlca.sqlState}`,
          { sqlState: sqlca.sqlState || '42704', vendorCode: sqlca.sqlCode },
        );
        return;
      }
      pkg.markCreated();
    } catch (err) {
      if (err && err.packagePolicy === 'exception') throw err;
      pkg.reportFailure(
        `CREATE PACKAGE threw: ${err?.message || err}`,
        { sqlState: '58004', vendorCode: 0 },
      );
      return;
    }

    if (!pkg.isCacheRequested()) return;

    try {
      const reqBuf = DBRequestDS.buildReturnPackage({
        rpbId,
        packageName: pkg.getName(),
        packageLibrary: pkg.getLibraryName(),
        identifierCcsid: this.#serverCCSID,
        returnSize: 0,
      });
      const replyBuf = await this.#connection.sendAndReceive(reqBuf);
      const reply = parseOperationReply(replyBuf, { serverCCSID: this.#serverCCSID });
      if (reply.sqlca && reply.sqlca.isError) {
        // Matches JDPackageManager.cache: disable caching on error,
        // leave extendedDynamic itself on.
        pkg.setCachedRaw(null, 0);
        return;
      }
      // ORS PACKAGE_INFORMATION bit makes the server return a
      // PACKAGE_INFO codepoint (0x380B) in the reply. Decode it so
      // the cache-hit skip-prepare path can pull statement metadata.
      const pkgInfoData = getCodePointData(reply, 0x380B);
      let packageInfo = null;
      let statementCount = 0;
      if (pkgInfoData && pkgInfoData.length >= 42) {
        try {
          packageInfo = parsePackageInfo(pkgInfoData, { serverCCSID: this.#serverCCSID });
          statementCount = packageInfo?.statementCount ?? 0;
        } catch {
          // Decode failure is non-fatal; fall back to opaque blob.
        }
      }
      pkg.setCachedRaw(replyBuf, statementCount, packageInfo);
    } catch {
      // Silent — cache is opportunistic. Leave created=true so
      // future prepares still carry the package name.
    }
  }
}
