/**
 * High-level SQL connection API.
 *
 * Wraps the engine-level DbConnection with an ergonomic JS interface
 * that mirrors java.sql.Connection: query(), execute(), prepare(),
 * createStatement(), prepareCall(), getMetaData(), transaction control,
 * client-info, read-only/holdability, warnings chain, and LOB factories.
 *
 * Upstream: AS400JDBCConnectionImpl.java
 * @module db/api/Connection
 */

import { Statement } from './Statement.js';
import { PreparedStatement } from './PreparedStatement.js';
import { CallableStatement } from './CallableStatement.js';
import { PreparedStatementCache } from './PreparedStatementCache.js';
import { DatabaseMetaData } from './DatabaseMetaData.js';
import { ResultSetHoldability } from './ResultSet.js';
import { SqlArray } from './SqlArray.js';
import { SqlWarning, warningFromSqlca } from './SqlWarning.js';
import { Blob } from '../lob/Blob.js';
import { Clob } from '../lob/Clob.js';
import { SQLXML } from '../lob/SQLXML.js';
import { IsolationLevel } from '../properties.js';

/** JDBC java.sql.Connection.TRANSACTION_* constants. */
export const TransactionIsolation = Object.freeze({
  none:             0,
  readUncommitted:  1,
  readCommitted:    2,
  repeatableRead:   4,
  serializable:     8,
});

const ISO_NUM_TO_NAME = Object.freeze({
  [TransactionIsolation.none]:            IsolationLevel.NONE,
  [TransactionIsolation.readUncommitted]: IsolationLevel.READ_UNCOMMITTED,
  [TransactionIsolation.readCommitted]:   IsolationLevel.READ_COMMITTED,
  [TransactionIsolation.repeatableRead]:  IsolationLevel.REPEATABLE_READ,
  [TransactionIsolation.serializable]:    IsolationLevel.SERIALIZABLE,
});

const ISO_NAME_TO_NUM = Object.freeze({
  [IsolationLevel.NONE]:             TransactionIsolation.none,
  [IsolationLevel.READ_UNCOMMITTED]: TransactionIsolation.readUncommitted,
  [IsolationLevel.READ_COMMITTED]:   TransactionIsolation.readCommitted,
  [IsolationLevel.REPEATABLE_READ]:  TransactionIsolation.repeatableRead,
  [IsolationLevel.SERIALIZABLE]:     TransactionIsolation.serializable,
});

const ISO_NAME_TO_SQL = Object.freeze({
  [IsolationLevel.NONE]:             'NO COMMIT',
  [IsolationLevel.READ_UNCOMMITTED]: 'UR',
  [IsolationLevel.READ_COMMITTED]:   'CS',
  [IsolationLevel.REPEATABLE_READ]:  'RS',
  [IsolationLevel.SERIALIZABLE]:     'RR',
});

export class Connection {
  #dbConnection;
  #closed;
  #readOnly;
  #holdability;
  #clientInfo;
  #catalog;
  #schema;
  #isolation;              // symbolic IsolationLevel.*
  #networkTimeoutMs;
  #warnings;
  #metaDataCache;
  #stmtCache;              // PreparedStatementCache
  #stmtCacheCap;

  /**
   * @param {import('../engine/DbConnection.js').DbConnection} dbConnection
   * @param {object} [opts]
   * @param {number} [opts.statementCacheSize=64] - prepared-stmt cache capacity
   */
  constructor(dbConnection, opts = {}) {
    this.#dbConnection = dbConnection;
    this.#closed = false;
    this.#readOnly = false;
    this.#holdability = ResultSetHoldability.closeCursorsAtCommit;
    this.#clientInfo = new Map();
    this.#catalog = '';
    this.#schema = '';
    this.#isolation = IsolationLevel.READ_UNCOMMITTED;
    this.#networkTimeoutMs = 0;
    this.#warnings = null;
    this.#metaDataCache = null;
    this.#stmtCacheCap = Math.max(0, opts.statementCacheSize ?? 64);
    this.#stmtCache = new PreparedStatementCache(this.#stmtCacheCap);
  }

  get connected() { return this.#dbConnection.connected && !this.#closed; }
  get closed() { return this.#closed; }

  /**
   * Execute a SELECT query and return rows as plain JS objects.
   * Supports optional parameter markers.
   *
   * @param {string} sql
   * @param {any[]} [params]
   * @returns {Promise<object[]>}
   */
  async query(sql, params) {
    this.#ensureOpen();

    if (params && params.length > 0) {
      const stmt = await this.prepare(sql);
      try {
        const result = await stmt.execute(params);
        return Array.isArray(result) ? result : [];
      } finally {
        await stmt.close();
      }
    }

    const statement = new Statement(this.#dbConnection, { connection: this });
    return statement.query(sql);
  }

  /**
   * Execute a DML statement (INSERT, UPDATE, DELETE, MERGE) or DDL.
   * Returns { affectedRows }.
   *
   * @param {string} sql
   * @param {any[]} [params]
   * @param {object} [opts]
   * @param {boolean} [opts.returnGeneratedKeys=false]
   * @returns {Promise<{ affectedRows: number, generatedKeys?: object[] }>}
   */
  async execute(sql, params, opts = {}) {
    this.#ensureOpen();

    // Any request for generated keys — even without bound parameters —
    // must go through the prepare/execute path so the statement can wrap
    // the INSERT in SELECT * FROM FINAL TABLE (...).
    const wantsKeys = Boolean(opts?.returnGeneratedKeys);
    const hasParams = Array.isArray(params) && params.length > 0;

    if (hasParams || wantsKeys) {
      const stmt = await this.prepare(sql);
      try {
        const result = await stmt.execute(params ?? [], opts);
        // Drain the inner prepared statement's warnings onto the
        // connection chain before its handle is released. Without
        // this graft the reply's SQLCA warnings would be lost when
        // the statement returns to the cache.
        const stmtWarnings = stmt.getWarnings?.();
        if (stmtWarnings) {
          if (!this.#warnings) this.#warnings = stmtWarnings;
          else this.#warnings.setNextWarning(stmtWarnings);
        }
        if (Array.isArray(result)) {
          return { affectedRows: result.length };
        }
        return result;
      } finally {
        await stmt.close();
      }
    }

    const result = await this.#executeImmediateWithWarning(sql);
    return result;
  }

  /**
   * Create a plain Statement for ad-hoc SQL execution.
   * JDBC: Connection.createStatement()
   * @returns {Statement}
   */
  createStatement() {
    this.#ensureOpen();
    return new Statement(this.#dbConnection, { connection: this });
  }

  /**
   * Prepare a SQL statement for repeated execution.
   * JDBC: Connection.prepareStatement()
   *
   * When the statement cache is active (capacity > 0), the engine-level
   * prepared statement handle is reused if the same SQL was prepared
   * previously, avoiding a round-trip to the server.
   *
   * @param {string} sql
   * @param {object} [opts]
   * @param {boolean} [opts.cache=true] - set false to bypass the cache
   * @param {string} [opts.cursorName] - explicit cursor name for
   *   positioned UPDATE/DELETE. When set, the cache is bypassed for
   *   this prepare (a named cursor pinned to a specific server-side
   *   RPB shouldn't be silently shared across callers).
   * @returns {Promise<PreparedStatement>}
   */
  async prepare(sql, opts = {}) {
    this.#ensureOpen();
    const explicitCursor = typeof opts.cursorName === 'string'
      && opts.cursorName.length > 0;
    // A named cursor is statement-specific identity; never serve it
    // from the cache (could leak the wrong cursor name to a peer
    // caller that prepared the same SQL).
    const useCache = this.#stmtCacheCap > 0 && opts.cache !== false && !explicitCursor;
    let handle = null;
    let cached = false;

    if (useCache) {
      // Lease an idle handle out of the cache (removed from idle set
      // until the PreparedStatement closes and returns it via the
      // release hook). This prevents the old bug where a closed
      // handle was still served from the cache.
      handle = this.#stmtCache.acquire(sql);
      cached = Boolean(handle);
    }
    if (!handle) {
      handle = await this.#dbConnection.prepareStatement(
        sql,
        explicitCursor ? { cursorName: opts.cursorName } : undefined,
      );
    }

    // Hand the PreparedStatement a release-back-to-cache hook. If
    // caching is disabled, the hook is a physical close.
    const releaseFn = useCache
      ? async (h) => this.#returnHandleToCache(sql, h)
      : null;

    return new PreparedStatement(this.#dbConnection, handle, sql, {
      onClose: releaseFn,
      wasCachedOnPrepare: cached,
    });
  }

  /**
   * Hook invoked by `PreparedStatement.close()` to hand its handle
   * back to the cache. If the cache evicts another handle to make
   * room (or rejects a duplicate), that evicted handle is physically
   * closed here.
   * @private
   */
  async #returnHandleToCache(sql, handle) {
    if (!handle || this.#closed) {
      if (handle) {
        try { await this.#dbConnection.statementManager.closeStatement(handle); } catch { /* ignore */ }
      }
      return;
    }
    const evicted = this.#stmtCache.release(sql, handle);
    if (evicted) {
      try { await this.#dbConnection.statementManager.closeStatement(evicted); } catch { /* ignore */ }
    }
  }

  /** Alias for prepare() with JDBC naming. */
  async prepareStatement(sql) { return this.prepare(sql); }

  /**
   * Prepare a CALL to a stored procedure.
   * JDBC: Connection.prepareCall()
   *
   * @param {string} [procedureName]
   * @returns {CallableStatement}
   */
  prepareCall(procedureName) {
    this.#ensureOpen();
    return new CallableStatement(this, procedureName);
  }

  /**
   * Call a stored procedure in one shot.
   *
   * @param {string} procedureName
   * @param {object} [opts]
   * @param {any[]} [opts.in]
   * @param {object[]} [opts.out]
   * @param {object[]} [opts.inout]
   * @returns {Promise<{ out: any[], resultSets: object[][] }>}
   */
  async call(procedureName, opts = {}) {
    this.#ensureOpen();
    const callable = new CallableStatement(this, procedureName);
    return callable.call(procedureName, opts);
  }

  /**
   * Pass-through SQL translation. IBM i does not require driver-side
   * escape translation (server parses standard SQL escapes directly),
   * so we return the input unchanged. Kept for JDBC parity.
   * @param {string} sql
   * @returns {string}
   */
  nativeSQL(sql) {
    return String(sql ?? '');
  }

  /**
   * Get a DatabaseMetaData helper for schema discovery.
   * Cached for the life of the connection (JDBC parity).
   * @returns {DatabaseMetaData}
   */
  getMetaData() {
    this.#ensureOpen();
    if (!this.#metaDataCache) {
      this.#metaDataCache = new DatabaseMetaData(this);
    }
    return this.#metaDataCache;
  }

  /** Legacy alias for getMetaData(). */
  metadata() { return this.getMetaData(); }

  /** @returns {import('../engine/DbConnection.js').DbConnection} */
  get dbConnection() { return this.#dbConnection; }

  // --- Transaction control ---

  /** Begin an explicit transaction (disable auto-commit). */
  async begin() {
    this.#ensureOpen();
    this.#dbConnection.setAutoCommit(false);
  }

  /** Commit the current transaction. */
  async commit() {
    this.#ensureOpen();
    this.#propagateSqlcaWarning(await this.#dbConnection.commit());
  }

  /**
   * Rollback the current transaction or to a savepoint.
   * @param {import('../engine/TransactionManager.js').Savepoint} [savepoint]
   */
  async rollback(savepoint) {
    this.#ensureOpen();
    if (savepoint) {
      this.#propagateResultWarning(
        await this.#dbConnection.rollbackToSavepoint(savepoint),
      );
    } else {
      this.#propagateSqlcaWarning(await this.#dbConnection.rollback());
    }
  }

  /**
   * Create a named savepoint.
   * @param {string} [name]
   * @returns {Promise<import('../engine/TransactionManager.js').Savepoint>}
   */
  async savepoint(name) {
    this.#ensureOpen();
    const result = await this.#dbConnection.setSavepoint(name);
    this.#propagateResultWarning(result);
    return result?.savepoint ?? result;
  }

  /** Alias for savepoint() with JDBC naming. */
  async setSavepoint(name) { return this.savepoint(name); }

  /**
   * Release a previously taken savepoint.
   * @param {import('../engine/TransactionManager.js').Savepoint|string} savepoint
   */
  async releaseSavepoint(savepoint) {
    this.#ensureOpen();
    this.#propagateResultWarning(
      await this.#dbConnection.releaseSavepoint(savepoint),
    );
  }

  /** @param {boolean} value */
  setAutoCommit(value) {
    this.#dbConnection.setAutoCommit(value);
  }

  /** @returns {boolean} */
  getAutoCommit() {
    return this.#dbConnection.getAutoCommit();
  }

  /**
   * Set the transaction isolation level (JDBC or symbolic form).
   * @param {number|string} level
   */
  async setTransactionIsolation(level) {
    this.#ensureOpen();
    let name;
    if (typeof level === 'number') {
      name = ISO_NUM_TO_NAME[level];
      if (!name) throw new RangeError(`Invalid transaction isolation: ${level}`);
    } else {
      name = String(level).toLowerCase();
      if (!ISO_NAME_TO_NUM.hasOwnProperty(name)) {
        throw new RangeError(`Invalid transaction isolation: ${level}`);
      }
    }
    this.#isolation = name;
    const sqlTag = ISO_NAME_TO_SQL[name];
    if (name === IsolationLevel.NONE) {
      await this.#executeImmediateWithWarning('SET CURRENT ISOLATION = NC');
    } else if (sqlTag) {
      await this.#executeImmediateWithWarning(
        `SET CURRENT ISOLATION = ${sqlTag}`,
      );
    }
  }

  /** @returns {number} TransactionIsolation.* numeric code */
  getTransactionIsolation() {
    return ISO_NAME_TO_NUM[this.#isolation] ?? TransactionIsolation.readUncommitted;
  }

  // --- Read-only / holdability ---

  /**
   * Set the read-only flag. Delivered to the server as "SET
   * TRANSACTION READ ONLY" when starting a transaction; kept as a
   * client-side hint when auto-commit is on.
   * @param {boolean} value
   */
  async setReadOnly(value) {
    this.#ensureOpen();
    this.#readOnly = Boolean(value);
    if (!this.getAutoCommit()) {
      const mode = this.#readOnly ? 'READ ONLY' : 'READ WRITE';
      try {
        await this.#executeImmediateWithWarning(`SET TRANSACTION ${mode}`);
      } catch (e) {
        this.addWarning(`Could not apply read-only mode: ${e.message}`);
      }
    }
  }

  /** @returns {boolean} */
  isReadOnly() { return this.#readOnly; }

  /** @param {number} h - ResultSetHoldability.* */
  setHoldability(h) {
    if (h !== ResultSetHoldability.holdCursorsOverCommit
        && h !== ResultSetHoldability.closeCursorsAtCommit) {
      throw new RangeError(`Invalid holdability: ${h}`);
    }
    this.#holdability = h;
  }

  /** @returns {number} */
  getHoldability() { return this.#holdability; }

  // --- Client info ---

  /**
   * Set a client-info property. Sends a SET CLIENT_INFO_* statement when
   * the key matches a standard JDBC key; otherwise stored locally.
   *
   * @param {string|object} nameOrMap - key or a full object
   * @param {string} [value]
   */
  async setClientInfo(nameOrMap, value) {
    this.#ensureOpen();
    if (typeof nameOrMap === 'object' && nameOrMap !== null) {
      for (const [k, v] of Object.entries(nameOrMap)) {
        await this.setClientInfo(k, v);
      }
      return;
    }
    const key = String(nameOrMap);
    const val = value == null ? '' : String(value);
    this.#clientInfo.set(key, val);
    const sqlKey = CLIENT_INFO_KEYS[key];
    if (sqlKey) {
      try {
        await this.#executeImmediateWithWarning(
          `CALL SYSPROC.WLM_SET_CLIENT_INFO(?,?,?,?,?)`,
        );
      } catch {
        // Not available on all IBM i releases — best-effort. We fall back
        // to SET CURRENT CLIENT_* which is always supported.
        try {
          await this.#executeImmediateWithWarning(
            `SET CURRENT ${sqlKey} = '${val.replace(/'/g, "''")}'`,
          );
        } catch (e) {
          this.addWarning(`setClientInfo(${key}) failed: ${e.message}`);
        }
      }
    }
  }

  /**
   * @param {string} [name]
   * @returns {string|Object<string,string>}
   */
  getClientInfo(name) {
    if (name == null) {
      return Object.fromEntries(this.#clientInfo);
    }
    return this.#clientInfo.get(String(name)) ?? '';
  }

  // --- Catalog / schema ---

  /**
   * Set the default schema (library). Issues SET SCHEMA on the server.
   * @param {string} schema
   */
  async setSchema(schema) {
    this.#ensureOpen();
    const name = String(schema || '').trim();
    this.#schema = name;
    if (name) {
      await this.#executeImmediateWithWarning(
        `SET SCHEMA "${name.replace(/"/g, '""')}"`,
      );
      const libraryList = this.#dbConnection.libraryList;
      if (libraryList) libraryList.defaultSchema = name;
    }
  }

  /** @returns {string} */
  getSchema() {
    const libraryList = this.#dbConnection.libraryList;
    return this.#schema || (libraryList ? libraryList.defaultSchema : '');
  }

  /** JDBC catalog concept maps loosely to RDB name; tracked client-side. */
  setCatalog(catalog) {
    this.#catalog = String(catalog || '');
  }

  /** @returns {string} */
  getCatalog() { return this.#catalog; }

  // --- Network timeout ---

  /**
   * @param {object|null} [executor] - JDBC Executor (unused in JS; accepted for parity)
   * @param {number} [ms]
   */
  setNetworkTimeout(executor, ms) {
    const v = typeof executor === 'number' ? executor : ms;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      throw new RangeError(`networkTimeout must be >= 0`);
    }
    this.#networkTimeoutMs = n | 0;
  }

  /** @returns {number} */
  getNetworkTimeout() { return this.#networkTimeoutMs; }

  // --- Validity / abort ---

  /**
   * Ping the server to check liveness.
   * @param {number} [timeoutSec=0]
   * @returns {Promise<boolean>}
   */
  async isValid(timeoutSec = 0) {
    if (this.#closed) return false;
    const prior = this.#networkTimeoutMs;
    try {
      if (timeoutSec > 0) {
        this.#networkTimeoutMs = timeoutSec * 1000;
      }
      await this.#dbConnection.executeImmediate(
        'SELECT 1 FROM SYSIBM.SYSDUMMY1 FETCH FIRST 1 ROW ONLY',
      );
      return true;
    } catch {
      return false;
    } finally {
      this.#networkTimeoutMs = prior;
    }
  }

  /**
   * Forcefully terminate the connection without normal shutdown.
   * JDBC: Connection.abort()
   */
  async abort() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#dbConnection.close();
    } catch { /* ignore */ }
  }

  // --- LOB / typed value factories ---

  /** Create an empty Blob for population and sending back. */
  createBlob() { return new Blob({ data: Buffer.alloc(0) }); }

  /** Create an empty Clob. */
  createClob() { return new Clob({ data: '' }); }

  /** Create an empty NClob (same shape as Clob in JS). */
  createNClob() { return new Clob({ data: '' }); }

  /** Create an empty SQLXML wrapper. */
  createSQLXML() { return new SQLXML({ data: '' }); }

  /**
   * Create a SQL ARRAY value.
   * @param {string} typeName - base element type name
   * @param {any[]} elements
   * @returns {SqlArray}
   */
  createArrayOf(typeName, elements) {
    return new SqlArray({ baseTypeName: String(typeName), elements });
  }

  /**
   * Create a SQL STRUCT. IBM i does not natively expose STRUCT over JDBC,
   * but the JDBC contract requires the method; we return a plain object
   * wrapper for parity.
   */
  createStruct(typeName, attributes) {
    return { typeName: String(typeName), attributes: attributes ?? [] };
  }

  // --- Warnings chain ---

  /** @returns {SqlWarning|null} */
  getWarnings() { return this.#warnings; }

  clearWarnings() { this.#warnings = null; }

  /** Append a warning to the chain. */
  addWarning(msg, opts = {}) {
    const w = msg instanceof SqlWarning ? msg : new SqlWarning(msg, opts);
    if (!this.#warnings) this.#warnings = w;
    else this.#warnings.setNextWarning(w);
  }

  /**
   * Fold a reply-side SQLCA's warning bits into the connection chain.
   * Fast-path safe: short-circuits to a no-op when the SQLCA is clean
   * (no allocation, no chain traversal). Used by the public
   * `execute()` / `commit()` / `rollback()` paths so callers see
   * server-side warnings even when they bypass `Statement` /
   * `PreparedStatement`.
   *
   * Per JDBC, Connection warnings are *cumulative* — they are not
   * cleared per-operation. Callers reset via `clearWarnings()`.
   */
  #propagateSqlcaWarning(sqlca) {
    const w = warningFromSqlca(sqlca);
    if (w) this.addWarning(w);
  }

  /**
   * Fold warning-bearing SQLCA out of either a plain SQLCA object or a
   * wrapper result object like `{ sqlca, affectedRows }`.
   * @param {object|null|undefined} result
   */
  #propagateResultWarning(result) {
    if (!result || typeof result !== 'object') return;
    if (result.sqlca) {
      this.#propagateSqlcaWarning(result.sqlca);
      return;
    }
    if ('sqlCode' in result || 'sqlState' in result || 'sqlwarn' in result) {
      this.#propagateSqlcaWarning(result);
    }
  }

  /**
   * Execute a connection-level control statement and fold reply-side
   * warnings into the JDBC-style cumulative Connection chain.
   * @param {string} sql
   */
  async #executeImmediateWithWarning(sql) {
    const result = await this.#dbConnection.executeImmediate(sql);
    this.#propagateResultWarning(result);
    return result;
  }

  // --- Pool integration ---

  /** Release a connection back to a pool (if pooled). */
  release() {
    if (this._pool) {
      this._pool.release(this);
    }
  }

  /**
   * Get statement cache statistics.
   * @returns {{ size: number, capacity: number, hits: number, misses: number, hitRate: number }}
   */
  statementCacheStats() {
    return this.#stmtCache.stats();
  }

  // --- Close ---

  /** Close the connection. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    // Drain every idle handle the cache still owns and physically
    // close them on the server. DbConnection.close() follows.
    const handles = this.#stmtCache.drain();
    for (const h of handles) {
      try { await this.#dbConnection.statementManager.closeStatement(h); } catch { /* ignore */ }
    }
    await this.#dbConnection.close();
  }

  #ensureOpen() {
    if (this.#closed) {
      throw new Error('Connection is closed');
    }
  }
}

/**
 * Standard JDBC client-info keys mapped to IBM i special register names.
 * Consumers can pass through arbitrary keys; only these are forwarded to
 * the server.
 */
const CLIENT_INFO_KEYS = Object.freeze({
  ApplicationName:   'CLIENT_APPLNAME',
  ClientUser:        'CLIENT_USERID',
  ClientHostname:    'CLIENT_WRKSTNNAME',
  ClientAccounting:  'CLIENT_ACCTNG',
  ClientProgramId:   'CLIENT_PROGRAMID',
});
