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
import { StatementManager, reserveConnectionRpbId } from './StatementManager.js';
import { CursorManager } from './CursorManager.js';
import { TransactionManager, Savepoint } from './TransactionManager.js';
import { LibraryList } from './LibraryList.js';
import { SortSequence } from './SortSequence.js';
import { PackageManager, deriveSuffixContext, isolationToCommitMode } from './PackageManager.js';

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
  #serverFunctionalLevel;
  #serverJobIdentifier;
  #cancelRpbId;
  #cancelChannel;
  #cancelChannelPromise;
  #cancelMetrics;
  #ownsSystem;

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
    this.#ownsSystem = opts._ownsSystem ?? false;
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
    this.#serverFunctionalLevel = 0;
    this.#serverJobIdentifier = null;
    // Side-channel cancel wiring. `#cancelChannel` is lazy — we do
    // NOT open a second DATABASE connection until the first cancel
    // request arrives. `#cancelMetrics` is a tiny diagnostic bag so
    // tests and bench can observe whether a real wire cancel (rather
    // than the post-RTT HY008 fallback) fired on a given request.
    this.#cancelRpbId = 0;
    this.#cancelChannel = null;
    this.#cancelChannelPromise = null;
    this.#cancelMetrics = {
      cancelCalls:      0,  // DbConnection.cancel() invocations
      cancelSent:       0,  // side-channel FUNCTIONID_CANCEL round-trips
      cancelFallbacks:  0,  // cancel() calls that fell back to post-RTT HY008
      cancelChannelOpens: 0,
    };
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
    this.#serverFunctionalLevel = exchReply.serverFunctionalLevel | 0;
    // Decode the 26-byte server job identifier from the server CCSID
    // so it can be re-encoded on the side-channel cancel request.
    // JTOpen's cancel path requires functionalLevel ≥ 5; we still
    // capture the identifier at lower levels for logging but the
    // wire cancel stays a no-op unless the level is sufficient.
    if (exchReply.serverJobIdentifier && exchReply.serverJobIdentifier.length > 0) {
      try {
        const { CharConverter } = await import('../../ccsid/CharConverter.js');
        const s = CharConverter.byteArrayToString(
          exchReply.serverJobIdentifier, 0, exchReply.serverJobIdentifier.length,
          this.#serverCCSID,
        );
        this.#serverJobIdentifier = s ? s : null;
      } catch {
        this.#serverJobIdentifier = null;
      }
    } else {
      this.#serverJobIdentifier = null;
    }

    Trace.log(Trace.JDBC,
      `Database connected: CCSID=${this.#serverCCSID} `
      + `DSLevel=${this.#serverDatastreamLevel} `
      + `funcLevel=${this.#serverFunctionalLevel} `
      + `jobId=${this.#serverJobIdentifier || '<unknown>'}`);

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
    // PackageManager must exist before StatementManager so the
    // manager can attach PACKAGE_NAME/LIBRARY_NAME codepoints on
    // every prepare. When extendedDynamic is off (or sqlPackage is
    // unset) the manager constructs in disabled state and every hot
    // path check collapses to one boolean read.
    //
    // Reserve a dedicated connection-scoped RPB id for package
    // operations. JTOpen's JDPackageManager takes the connection's
    // `id_` and uses it for CREATE_PACKAGE / RETURN_PACKAGE — NOT a
    // per-statement RPB. Reusing an in-flight prepare's handle
    // confuses server-side package identity on real hosts, so js400
    // allocates once here and threads that id into the manager.
    const packageRpbId = reserveConnectionRpbId();
    // Reserve a second connection-scoped RPB id for the side-channel
    // cancel requests (JTOpen uses connection `id_` on the cancel
    // packet). Picked once at connect so the side-channel's wire
    // shape is deterministic.
    this.#cancelRpbId = reserveConnectionRpbId();
    // Build the JTOpen-shape suffix context from the caller's
    // connection properties + commit mode. This is what makes the
    // 4-char suffix compatible with a JTOpen client talking to the
    // same server-side package.
    const commitMode = isolationToCommitMode(this.#properties.isolation);
    const suffixContext = deriveSuffixContext(this.#properties, commitMode);
    this.#packageManager = new PackageManager({
      extendedDynamic: managerOpts.extendedDynamic === true,
      packageCache: managerOpts.packageCache === true,
      packageName: managerOpts.packageName,
      packageLibrary: managerOpts.packageLibrary,
      packageCriteria: typeof this.#userOpts?.packageCriteria === 'string'
        ? this.#userOpts.packageCriteria : undefined,
      errorPolicy: typeof this.#userOpts?.packageError === 'string'
        ? this.#userOpts.packageError : undefined,
      suffixContext,
      rpbId: packageRpbId,
    });
    this.#statementManager = new StatementManager(this.#connection, this.#cursorManager, {
      ...managerOpts,
      packageManager: this.#packageManager,
    });
    this.#transactionManager = new TransactionManager(this.#connection, {
      ...managerOpts,
      autoCommit: this.#properties.autoCommit,
    });
    this.#libraryList = new LibraryList({
      libraries: this.#properties.libraries,
      defaultSchema: this.#properties.defaultSchema,
    });
    this.#sortSequence = new SortSequence(this.#properties.sortSequence || {});

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

  /**
   * Drain a pending SQL-package warning, if any. Used by the API
   * `Connection` layer after each prepare/execute boundary so
   * `packageError='warning'` failures surface on the normal
   * `Connection.getWarnings()` chain.
   *
   * Returns a SqlWarning instance on first call, `null` thereafter.
   * Cheap no-op when the package manager is disabled.
   */
  drainPackageWarning() {
    return this.#packageManager?.takeWarning?.() ?? null;
  }

  get serverFunctionalLevel() { return this.#serverFunctionalLevel; }
  get serverJobIdentifier() { return this.#serverJobIdentifier; }
  get cancelMetrics() { return this.#cancelMetrics; }

  /**
   * True when a real wire-level cancel is theoretically possible on
   * this connection. Mirrors the guard in JTOpen's
   * `AS400JDBCConnectionImpl.cancel`:
   *
   *   if ((serverJobIdentifier_ != null) && (serverFunctionalLevel_ >= 5))
   *
   * Used by the api layer as a cheap pre-check so tests and callers
   * can tell upfront whether cancel will hit the wire or fall back
   * to the post-RTT HY008 path.
   */
  canCancelOnWire() {
    return !!(this.#serverJobIdentifier && this.#serverFunctionalLevel >= 5);
  }

  /**
   * Inject a wire-level FUNCTIONID_CANCEL on a dedicated side channel.
   *
   * Mirrors `AS400JDBCConnectionImpl.cancel(int id)`:
   *   1. Lazy-open a second DATABASE connection (JTOpen spins up a
   *      whole new AS400JDBCConnectionImpl; we reuse this.#system).
   *   2. Build FUNCTIONID_CANCEL (0x1818) carrying the target
   *      connection's server job identifier.
   *   3. Fire-and-forget — we wait for the reply but ignore the
   *      template return code (cancel is best-effort; the primary
   *      connection's in-flight operation will return with an
   *      interrupted SQLCA on its own).
   *   4. Keep the side channel open for reuse on subsequent cancels.
   *
   * Performance gates:
   *   - `queryTimeout = 0` and no explicit `cancel()` call → this
   *     method is never reached. No side-channel chatter.
   *   - First cancel pays the signon cost once; subsequent cancels
   *     reuse the socket.
   *   - If the server isn't at functional level 5 or the job
   *     identifier was never captured, we bail early and bump the
   *     `cancelFallbacks` counter so the caller knows to rely on
   *     post-RTT HY008.
   *
   * @returns {Promise<{ sent: boolean, reason?: string }>}
   *   `sent: true` means a FUNCTIONID_CANCEL round-trip actually
   *   completed. `sent: false` with a `reason` means the fallback
   *   path should run.
   */
  async cancel() {
    this.#cancelMetrics.cancelCalls++;

    if (!this.canCancelOnWire()) {
      this.#cancelMetrics.cancelFallbacks++;
      return {
        sent: false,
        reason: this.#serverFunctionalLevel < 5
          ? `server functional level ${this.#serverFunctionalLevel} < 5`
          : 'server job identifier not captured',
      };
    }

    let channel;
    try {
      channel = await this.#ensureCancelChannel();
    } catch (err) {
      this.#cancelMetrics.cancelFallbacks++;
      return { sent: false, reason: `side channel unavailable: ${err?.message || err}` };
    }

    try {
      const reqBuf = DBRequestDS.buildCancel({
        rpbId: this.#cancelRpbId,
        jobIdentifier: this.#serverJobIdentifier,
        identifierCcsid: this.#serverCCSID,
      });
      await channel.sendAndReceive(reqBuf);
      this.#cancelMetrics.cancelSent++;
      return { sent: true };
    } catch (err) {
      // The cancel round-trip failed — fall back to the post-RTT
      // HY008 behavior. Don't propagate the error to the caller:
      // cancel is best-effort in JTOpen too.
      this.#cancelMetrics.cancelFallbacks++;
      return { sent: false, reason: `cancel send failed: ${err?.message || err}` };
    }
  }

  /**
   * Test hook — allow callers to inject a synthetic cancel channel
   * (e.g. a unit test that wants to capture the wire bytes without
   * opening a real socket). When set, `#ensureCancelChannel` returns
   * this object directly and skips the DATABASE-service handshake.
   *
   * The injected object must expose `sendAndReceive(buf) → Promise`.
   */
  setCancelChannelForTesting(channel) {
    this.#cancelChannel = channel;
  }

  /**
   * Lazily open the side-channel DATABASE connection. Caches the
   * connection so subsequent cancel calls reuse the same socket.
   * Coalesces concurrent first-time requests via a shared promise.
   */
  async #ensureCancelChannel() {
    if (this.#cancelChannel) return this.#cancelChannel;
    if (this.#cancelChannelPromise) return this.#cancelChannelPromise;

    this.#cancelChannelPromise = (async () => {
      const ch = await this.#openCancelChannel();
      this.#cancelChannel = ch;
      this.#cancelMetrics.cancelChannelOpens++;
      this.#cancelChannelPromise = null;
      return ch;
    })().catch((err) => {
      this.#cancelChannelPromise = null;
      throw err;
    });
    return this.#cancelChannelPromise;
  }

  /**
   * Open a second DATABASE-service connection using the same AS400
   * system as the primary, perform seed exchange + signon + attribute
   * exchange (same three-step handshake as the primary connection),
   * and return the raw socket wrapper. Keeps the socket open for
   * future cancel round-trips.
   */
  async #openCancelChannel() {
    const conn = await this.#system.connectService(Service.DATABASE);

    const seedReq = SeedExchange.buildRequest(ServerID.DATABASE);
    const seedReplyBuf = await conn.sendAndReceive(seedReq.buffer);
    const seedReply = SeedExchange.parseReply(seedReplyBuf);

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
    const startReplyBuf = await conn.sendAndReceive(startReq);
    ServerStart.parseReply(startReplyBuf);

    const exchBuf = DBRequestDS.buildExchangeAttributes({
      ccsid: 13488,
      datastreamLevel: 5,
    });
    await conn.sendAndReceive(exchBuf);

    return conn;
  }

  // --- Close ---

  async close() {
    if (!this.#connected) return;

    try {
      if (this.#statementManager) await this.#statementManager.closeAll();
    } catch { /* ignore */ }

    try {
      if (this.#cursorManager) await this.#cursorManager.closeAll();
    } catch { /* ignore */ }

    // Close the side-channel cancel connection if we opened one.
    // Best-effort; never let a cancel-channel close error mask the
    // primary close path.
    if (this.#cancelChannel && typeof this.#cancelChannel.close === 'function') {
      try { await this.#cancelChannel.close(); } catch { /* ignore */ }
    }
    this.#cancelChannel = null;

    // Close the database host-server socket so the event loop can drain.
    if (this.#connection && typeof this.#connection.close === 'function') {
      try { this.#connection.close(); } catch { /* ignore */ }
    }
    this.#connection = null;

    // If this DbConnection created the AS400 system internally
    // (pool / options-based connect), close it to release the signon socket.
    if (this.#ownsSystem && this.#system) {
      try { await this.#system.close(); } catch { /* ignore */ }
    }
    this.#system = null;

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
