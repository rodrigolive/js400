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
   * @param {object} [opts] - connection properties
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
  constructor(system, opts = {}) {
    this.#system = system;
    this.#properties = { ...defaultProperties, ...opts };
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

    // Step 5: Initialize managers
    const managerOpts = { serverCCSID: this.#serverCCSID };
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
   * @returns {Promise<PreparedStatementHandle>}
   */
  async prepareStatement(sql) {
    this.#ensureConnected();
    return this.#statementManager.prepareStatement(sql);
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
}
