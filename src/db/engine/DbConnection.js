/**
 * Database session state.
 *
 * Top-level database connection object that coordinates authentication,
 * attribute exchange, statement management, cursor management, and
 * transaction control over the IBM i database host server.
 *
 * Upstream: AS400JDBCConnectionImpl.java
 * @module db/engine/DbConnection
 */

import { Service, ServerID } from '../../core/constants.js';
import { SeedExchange } from '../../transport/SeedExchange.js';
import { ServerStart } from '../../transport/ServerStart.js';
import { encryptPassword, stringToEbcdic } from '../../auth/password-encrypt.js';
import { Trace } from '../../core/Trace.js';
import { DBRequestDS } from '../protocol/DBRequestDS.js';
import { parseExchangeAttributes, parseOperationReply, throwIfError } from '../protocol/DBReplyDS.js';
import { defaultProperties, Naming } from '../properties.js';
import { StatementManager } from './StatementManager.js';
import { CursorManager } from './CursorManager.js';
import { TransactionManager, Savepoint } from './TransactionManager.js';
import { LibraryList } from './LibraryList.js';
import { SortSequence } from './SortSequence.js';
import { PackageManager } from './PackageManager.js';

const DB_STATE = Symbol.for('js400.dbState');

export class DbConnection {
  #system;
  #connection;
  #properties;
  #userOpts;
  #connected;
  #serverCCSID;
  #serverVersion;
  #serverDatastreamLevel;
  #serverAttributes;
  #statementManager;
  #cursorManager;
  #transactionManager;
  #libraryList;
  #sortSequence;
  #packageManager;

  /**
   * @param {import('../../core/AS400.js').AS400} system - authenticated AS400 instance
   * @param {object} [opts] - normalized connection properties
   * @param {object} [rawOpts] - caller-supplied properties before default
   *   merging; kept so engine knobs can distinguish explicit opt-in from
   *   library defaults.
   * @param {string} [opts.naming='sql']
   * @param {string[]} [opts.libraries=[]]
   * @param {string} [opts.dateFormat]
   * @param {string} [opts.timeFormat]
   * @param {string} [opts.dateSeparator]
   * @param {string} [opts.timeSeparator]
   * @param {boolean} [opts.autoCommit=true]
   * @param {string} [opts.defaultSchema]
   * @param {object} [opts.sortSequence]
   */
  constructor(system, opts = {}, rawOpts = opts) {
    this.#system = system;
    this.#properties = { ...defaultProperties, ...opts };
    // Retain the pre-normalization opts bag so engine-level knobs that
    // should only fire on explicit opt-in (e.g. holdStatements,
    // blockSize) can distinguish "user set this" from "library default
    // merged in." Passing the normalized bag here would make defaults
    // like blockSize=32 look explicit and silently change runtime
    // behavior for callers who never asked for it.
    this.#userOpts = rawOpts || {};
    this.#connected = false;
    this.#serverCCSID = 37;
    this.#serverVersion = 0;
    this.#serverDatastreamLevel = 0;
    this.#serverAttributes = 0;
  }

  get connected() { return this.#connected; }

  getServerCCSID() { return this.#serverCCSID; }
  getServerVersion() { return this.#serverVersion; }
  getServerDatastreamLevel() { return this.#serverDatastreamLevel; }
  getServerAttributes() { return this.#serverAttributes; }

  /**
   * Connect to the database server and exchange attributes.
   * This handles:
   * 1. TCP/TLS connection
   * 2. Seed exchange + authentication
   * 3. Database-specific attribute exchange
   * 4. Library list / schema setup
   * 5. Sort sequence setup
   */
  async connect() {
    if (this.#connected) return;

    // Step 1: Connect to database service
    this.#connection = await this.#system.connectService(Service.DATABASE);

    // Step 2: Seed exchange
    const seedReq = SeedExchange.buildRequest(ServerID.DATABASE);
    const seedReplyBuf = await this.#connection.sendAndReceive(seedReq.buffer);
    const seedReply = SeedExchange.parseReply(seedReplyBuf);

    // Step 3: Server start (authenticate)
    const serverInfo = this.#system.getServerInfo();
    const encryptedPw = encryptPassword({
      userId: this.#system.user,
      password: this.#system.password,
      clientSeed: seedReq.clientSeed,
      serverSeed: seedReply.serverSeed,
      passwordLevel: serverInfo.passwordLevel ?? 0,
    });

    const userIdEbcdic = stringToEbcdic(this.#system.user, true);
    const startReq = ServerStart.buildRequest({
      serverId: ServerID.DATABASE,
      authenticationBytes: Buffer.from(encryptedPw),
      userIdBytes: Buffer.from(userIdEbcdic),
      authScheme: 0,
    });
    const startReplyBuf = await this.#connection.sendAndReceive(startReq);
    ServerStart.parseReply(startReplyBuf);

    // Step 4: Exchange database server attributes
    const exchBuf = DBRequestDS.buildExchangeAttributes({
      ccsid: 13488,
      datastreamLevel: 5,
    });
    const exchReplyBuf = await this.#connection.sendAndReceive(exchBuf);
    const exchReply = parseExchangeAttributes(exchReplyBuf);

    this.#serverCCSID = exchReply.serverCCSID || 37;
    this.#serverDatastreamLevel = exchReply.serverDatastreamLevel;
    this.#serverAttributes = exchReply.serverAttributes;

    Trace.log(Trace.JDBC, `Database connected: CCSID=${this.#serverCCSID} DSLevel=${this.#serverDatastreamLevel}`);

    // Step 5: Initialize managers.
    //
    // Explicit opt-in knobs — only applied when the caller set them;
    // otherwise the engine keeps its prior defaults so existing
    // callers see zero behavior change when the knob is off.
    const managerOpts = {
      serverCCSID: this.#serverCCSID,
      holdIndicator: this.#explicitHoldIndicator(this.#userOpts),
      // Performance knobs in plumbing-only state per boss's
      // first-pass rule: surfaced on the engine for counter
      // visibility and for a future pass to act on, but not
      // wired to any wire-shape change yet. The fast path is
      // unchanged when these are unset.
      extendedDynamic: this.#explicitBoolean(this.#userOpts, 'extendedDynamic'),
      packageCache: this.#explicitBoolean(this.#userOpts, 'packageCache'),
      blockSizeKB: this.#explicitNumber(this.#userOpts, 'blockSize'),
      packageName: typeof this.#userOpts?.sqlPackage === 'string'
        ? this.#userOpts.sqlPackage : null,
      packageLibrary: typeof this.#userOpts?.packageLibrary === 'string'
        ? this.#userOpts.packageLibrary : null,
    };
    this.#cursorManager = new CursorManager(this.#connection, managerOpts);
    this.#statementManager = new StatementManager(this.#connection, this.#cursorManager, managerOpts);
    this.#transactionManager = new TransactionManager(this.#connection, {
      ...managerOpts,
      autoCommit: this.#properties.autoCommit,
    });
    this.#libraryList = new LibraryList({
      libraries: this.#properties.libraries,
      defaultSchema: this.#properties.defaultSchema,
    });
    this.#sortSequence = new SortSequence(this.#properties.sortSequence || {});
    this.#packageManager = new PackageManager();

    this.#connected = true;

    // Step 6: Apply initial configuration via SQL
    await this.#applyInitialSettings();
  }

  /**
   * Apply library list, schema, naming, and sort sequence settings.
   */
  async #applyInitialSettings() {
    const setSchema = this.#libraryList.toSetSchemaSQL();
    if (setSchema) {
      try {
        await this.executeImmediate(setSchema);
      } catch (e) {
        Trace.log(Trace.JDBC, `Failed to set schema: ${e.message}`);
      }
    }

    const setPath = this.#libraryList.toSetPathSQL();
    if (setPath) {
      try {
        await this.executeImmediate(setPath);
      } catch (e) {
        Trace.log(Trace.JDBC, `Failed to set path: ${e.message}`);
      }
    }

    const sortSql = this.#sortSequence.toSetSQL();
    if (sortSql) {
      try {
        await this.executeImmediate(sortSql);
      } catch (e) {
        Trace.log(Trace.JDBC, `Failed to set sort sequence: ${e.message}`);
      }
    }

    if (this.#properties.naming === Naming.SYSTEM) {
      try {
        await this.executeImmediate('SET OPTION NAMING = *SYS');
      } catch (e) {
        Trace.log(Trace.JDBC, `Failed to set naming: ${e.message}`);
      }
    }
  }

  // --- Statement API (delegates to StatementManager) ---

  /**
   * Prepare a SQL statement.
   * @param {string} sql
   * @param {object} [opts]
   * @param {string} [opts.cursorName] - explicit cursor name for
   *   positioned UPDATE/DELETE; pass-through to StatementManager.
   * @returns {Promise<PreparedStatementHandle>}
   */
  async prepareStatement(sql, opts) {
    this.#ensureConnected();
    return this.#statementManager.prepareStatement(sql, opts);
  }

  /**
   * Execute a SQL string immediately (no prepare).
   * @param {string} sql
   * @returns {Promise<{ sqlca: object, affectedRows: number }>}
   */
  async executeImmediate(sql) {
    this.#ensureConnected();
    return this.#statementManager.executeImmediate(sql);
  }

  // --- Transaction API (delegates to TransactionManager) ---

  async commit() {
    this.#ensureConnected();
    return this.#transactionManager.commit();
  }

  async rollback() {
    this.#ensureConnected();
    return this.#transactionManager.rollback();
  }

  async setSavepoint(name) {
    this.#ensureConnected();
    return this.#transactionManager.setSavepoint(name);
  }

  async rollbackToSavepoint(savepoint) {
    this.#ensureConnected();
    return this.#transactionManager.rollbackToSavepoint(savepoint);
  }

  async releaseSavepoint(savepoint) {
    this.#ensureConnected();
    return this.#transactionManager.releaseSavepoint(savepoint);
  }

  setAutoCommit(value) {
    if (this.#transactionManager) {
      this.#transactionManager.autoCommit = value;
    }
    this.#properties.autoCommit = value;
  }

  getAutoCommit() {
    return this.#transactionManager
      ? this.#transactionManager.autoCommit
      : this.#properties.autoCommit;
  }

  // --- Getters ---

  get statementManager() { return this.#statementManager; }
  get cursorManager() { return this.#cursorManager; }
  get transactionManager() { return this.#transactionManager; }
  get libraryList() { return this.#libraryList; }
  get sortSequence() { return this.#sortSequence; }
  get packageManager() { return this.#packageManager; }

  // --- Close ---

  async close() {
    if (!this.#connected) return;

    try {
      if (this.#statementManager) await this.#statementManager.closeAll();
    } catch { /* ignore */ }

    try {
      if (this.#cursorManager) await this.#cursorManager.closeAll();
    } catch { /* ignore */ }

    this.#connected = false;
    Trace.log(Trace.JDBC, 'Database connection closed');
  }

  #ensureConnected() {
    if (!this.#connected) {
      throw new Error('Database connection is not open. Call connect() first.');
    }
  }

  /**
   * Translate the JTOpen `holdStatements` boolean (or explicit numeric
   * HOLD_INDICATOR byte) into the wire value passed to CREATE RPB.
   * Returns `null` unless the caller *explicitly* set the property,
   * leaving DB2 on its default behavior (cursor closes at commit).
   * Accepted forms: `true` / `false`, or a numeric byte.
   */
  /**
   * Read a *boolean* opt only if the caller explicitly set it.
   * Returns `null` (not `false`) when the property is absent so
   * downstream code can distinguish "user said off" from "user
   * didn't say". This is the same opt-in discipline the
   * `holdStatements` knob uses — a future runtime change behind a
   * knob can detect both states without surprising defaults.
   */
  #explicitBoolean(opts, name) {
    if (!opts || !Object.prototype.hasOwnProperty.call(opts, name)) {
      return null;
    }
    return Boolean(opts[name]);
  }

  #explicitNumber(opts, name) {
    if (!opts || !Object.prototype.hasOwnProperty.call(opts, name)) {
      return null;
    }
    const n = Number(opts[name]);
    return Number.isFinite(n) ? n : null;
  }

  #explicitHoldIndicator(opts) {
    if (!opts || !Object.prototype.hasOwnProperty.call(opts, 'holdStatements')) {
      return null;
    }
    const v = opts.holdStatements;
    if (typeof v === 'number') return v & 0xFF;
    return v ? 0x01 : 0x00;
  }
}
