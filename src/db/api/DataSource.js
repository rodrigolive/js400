/**
 * JDBC-style DataSource with JTOpen property breadth.
 *
 * Mirrors the property surface of `com.ibm.as400.access.AS400JDBCDataSource`
 * so applications that configure a DataSource in the Java style
 * (`ds.setServerName(...); ds.setLibraries(...)`) can port directly to
 * js400.
 *
 * Not every JTOpen property maps to a runtime behavior in js400. Properties
 * whose effect is client-side (e.g. blockSize, prefetch, packageCache) are
 * stored verbatim and threaded through `connect()` via normalized options;
 * properties that control behavior js400 does not yet implement (e.g. XA,
 * client reroute) are stored so that calling code can round-trip the full
 * configuration, but they do not yet drive new runtime behavior.
 *
 * The minimal interface a consumer must know:
 *   - `setServerName(host)` / `setUser(user)` / `setPassword(pw)`
 *   - `setDatabaseName(schema)` or `setLibraries("LIB1,LIB2,QTEMP")`
 *   - `await ds.getConnection()` returns a `Connection`
 *
 * Upstream: AS400JDBCDataSource.java, AS400JDBCConnectionPoolDataSource.java
 * @module db/api/DataSource
 */

import { connect } from '../connect.js';
import { ConnectionPool } from '../pool/ConnectionPool.js';

/**
 * Mapping from JTOpen camelCase setter property names to js400 option keys.
 * Properties that have no runtime counterpart are still remembered in the
 * internal property bag so the configuration round-trips. Adding a mapping
 * here is safe: unmapped properties are passed through verbatim via the
 * returned plain-JS options bag.
 */
const PROPERTY_ALIASES = Object.freeze({
  serverName: 'host',
  databaseName: 'defaultSchema',
  user: 'user',
  password: 'password',
  portNumber: 'port',
  secure: 'secure',
  naming: 'naming',
  libraries: 'libraries',
  dateFormat: 'dateFormat',
  dateSeparator: 'dateSeparator',
  timeFormat: 'timeFormat',
  timeSeparator: 'timeSeparator',
  decimalSeparator: 'decimalSeparator',
  translateBinary: 'translateBinary',
  trueAutoCommit: 'trueAutoCommit',
  cursorHold: 'cursorHold',
  cursorSensitivity: 'cursorSensitivity',
  sort: 'sort',
  sortLanguage: 'sortLanguage',
  sortTable: 'sortTable',
  sortWeight: 'sortWeight',
});

/**
 * Known property names recognized by JTOpen's AS400JDBCDataSource. Stored
 * for future use so the reference shape is visible in one place. Not every
 * entry here maps to a js400 behavior yet.
 */
const KNOWN_JTOPEN_PROPERTIES = Object.freeze([
  'access', 'additionalAuthenticationFactor', 'affinityFailbackInterval',
  'behaviorOverride', 'bidiImplicitReordering', 'bidiNumericOrdering',
  'bidiStringType', 'blockCriteria', 'blockSize',
  'characterTruncation', 'clientRerouteAlternatePortNumber',
  'clientRerouteAlternateServerName', 'concurrentAccessResolution',
  'cursorHold', 'cursorSensitivity', 'databaseName', 'dataSourceName',
  'dataTruncation', 'dateFormat', 'dateSeparator',
  'decfloatRoundingMode', 'decimalDataErrors', 'decimalSeparator',
  'description', 'driver', 'enableClientAffinitiesList',
  'enableSeamlessFailover', 'errors', 'extendedDynamic',
  'extendedMetaData', 'fullOpen', 'holdInputLocators', 'holdStatements',
  'ignoreWarnings', 'jvmMaxHeapSize', 'keepAlive', 'keyRingName',
  'keyRingPassword', 'lazyClose', 'libraries', 'lobThreshold',
  'loginTimeout', 'maxRetriesForClientReroute', 'metaDataSource',
  'naming', 'numericRangeError', 'package', 'packageAdd', 'packageCache',
  'packageCCSID', 'packageClear', 'packageCriteria', 'packageError',
  'packageLibrary', 'password', 'portNumber', 'prefetch',
  'proxyServer', 'qaqqiniLibrary', 'queryOptimizeGoal',
  'queryReplaceTruncatedParameter', 'queryStorageLimit',
  'queryTimeoutMechanism', 'receiveBufferSize', 'remarks',
  'retryIntervalForClientReroute', 'rollbackCursorHold', 'savePasswordWhenSerialized',
  'secondaryUrl', 'secure', 'sendBufferSize', 'serverName',
  'serverTraceCategories', 'socketTimeout', 'sort', 'sortLanguage',
  'sortTable', 'sortWeight', 'soTimeout', 'tcpNoDelay', 'threadUsed',
  'timeFormat', 'timeSeparator', 'timestampFormat',
  'tlsKeystore', 'tlsKeystorePassword', 'tlsTruststore',
  'tlsTruststorePassword', 'toolboxTrace', 'trace', 'translateBinary',
  'translateBoolean', 'translateHex', 'trimCharFields', 'trueAutoCommit',
  'useBlockUpdate', 'useDrda', 'useSock5', 'user',
  'variableFieldCompression', 'xaLooselyCoupledSupport',
]);

/**
 * AS400JDBCDataSource-style DataSource.
 *
 * Exposes the JTOpen property surface as simple getters/setters and a
 * `getConnection()` factory. Each setter accepts the same types as the
 * Java equivalent (booleans, strings, numbers), stores them verbatim,
 * and exposes them via a symmetric getter.
 */
export class DataSource {
  #props;

  /**
   * @param {object} [props] - initial property bag keyed by JTOpen property name
   */
  constructor(props = {}) {
    this.#props = { ...(props || {}) };
  }

  /** @returns {string[]} the list of recognized JTOpen property names */
  static get knownProperties() { return [...KNOWN_JTOPEN_PROPERTIES]; }

  /** @returns {object} a shallow copy of the stored property bag */
  getProperties() { return { ...this.#props }; }

  /** @param {string} name @param {any} value */
  setProperty(name, value) { this.#props[String(name)] = value; }

  /** @param {string} name */
  getProperty(name) { return this.#props[String(name)]; }

  /**
   * Build a plain options object suitable for passing to `connect()`.
   * Translates JTOpen property names to js400 option keys where a mapping
   * exists; otherwise the property is passed through verbatim.
   */
  toConnectOptions() {
    const opts = {};
    for (const [k, v] of Object.entries(this.#props)) {
      const mapped = PROPERTY_ALIASES[k];
      opts[mapped || k] = v;
    }
    return opts;
  }

  /**
   * Open a new connection using the currently-configured properties.
   * Optional user/password overrides match the JDBC
   * `getConnection(user, password)` overload.
   *
   * @param {string} [userOrOpts]
   * @param {string} [password]
   * @returns {Promise<import('./Connection.js').Connection>}
   */
  async getConnection(userOrOpts, password) {
    const opts = this.toConnectOptions();
    if (typeof userOrOpts === 'string') {
      opts.user = userOrOpts;
      if (password !== undefined) opts.password = password;
    } else if (userOrOpts && typeof userOrOpts === 'object') {
      Object.assign(opts, userOrOpts);
    }
    return connect(opts);
  }

  /**
   * JNDI `Referenceable.getReference()` approximation: returns a serialisable
   * plain-object description of this DataSource.
   */
  getReference() {
    return {
      className: 'com.ibm.as400.access.AS400JDBCDataSource',
      factoryClassName: 'com.ibm.as400.access.AS400JDBCObjectFactory',
      properties: { ...this.#props },
    };
  }
}

/**
 * ConnectionPoolDataSource equivalent. Wraps a DataSource with a managed
 * js400 ConnectionPool so callers can do:
 *
 *   const cpds = new ConnectionPoolDataSource();
 *   cpds.setServerName('host'); cpds.setUser('u'); cpds.setPassword('p');
 *   const pool = cpds.getPool();
 *   const c = await pool.getConnection();
 */
export class ConnectionPoolDataSource extends DataSource {
  #pool;

  constructor(props) {
    super(props);
    this.#pool = null;
  }

  /**
   * Return (or lazily create) the underlying ConnectionPool.
   *
   * Lifecycle contract:
   *   - The pool is created on the first `getPool()` call using a snapshot
   *     of the DataSource's properties at that moment (via
   *     `toConnectOptions()`).
   *   - Subsequent mutations to DataSource properties (e.g. calling
   *     `setLibraries()` after `getPool()`) do NOT retroactively affect
   *     the already-created pool. This is deliberate: rebuilding the
   *     pool on every setter would cause silent pool churn and
   *     reconnect storms from innocent setter calls.
   *   - To reconfigure, call `closePool()` first, then mutate properties,
   *     then call `getPool()` again.
   *
   * @param {object} [poolOpts] - pool size / timeout options
   */
  getPool(poolOpts = {}) {
    if (!this.#pool) {
      const opts = this.toConnectOptions();
      this.#pool = new ConnectionPool({
        ...poolOpts,
        ...opts,
        connect: () => connect(opts),
      });
    }
    return this.#pool;
  }

  /**
   * Close the current pool (if any) and forget it. A subsequent
   * `getPool()` call will create a fresh pool that picks up the latest
   * DataSource properties. No-op when no pool was ever created.
   * @returns {Promise<void>}
   */
  async closePool() {
    const pool = this.#pool;
    this.#pool = null;
    if (pool) {
      try { await pool.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Inject a pool directly. Primarily for tests that want to exercise
   * `getPooledConnection()` without hitting the network. If a pool was
   * already created, the caller is responsible for closing the old one.
   * @param {ConnectionPool} pool
   */
  __setPool(pool) { this.#pool = pool; }

  /**
   * Return a `javax.sql.PooledConnection`-style wrapper:
   *   { getConnection, close, addConnectionEventListener,
   *     addStatementEventListener, removeConnectionEventListener,
   *     removeStatementEventListener }
   *
   * Semantics:
   *   - The default overload (`getPooledConnection()`) checks out a
   *     connection from the underlying `ConnectionPool` (`pool.getConnection()`).
   *     Logical `close()` on the returned wrapper returns the physical
   *     connection to the pool (`pool.release(conn)`) — it does NOT
   *     physically close it, so a subsequent checkout reuses the same
   *     connection and avoids a new signon RTT.
   *   - The credentials overload (`getPooledConnection(user, password)`)
   *     always opens a brand-new physical connection with those
   *     credentials (JDBC-parity behavior) and bypasses the pool. In that
   *     branch, logical `close()` physically closes the connection since
   *     there is no pool to return it to.
   */
  async getPooledConnection(user, password) {
    const useBypass = user !== undefined;
    const pool = useBypass ? null : this.getPool();
    const physical = useBypass
      ? await this.getConnection(user, password)
      : await pool.getConnection();

    const listeners = { connection: [], statement: [] };
    let logicalClosed = false;

    const wrapper = {
      getConnection() { return physical; },
      async close() {
        if (logicalClosed) return;
        logicalClosed = true;
        for (const fn of listeners.connection) {
          try { fn.connectionClosed?.({ source: wrapper }); } catch { /* ignore */ }
        }
        if (useBypass) {
          // Bypass branch owns the physical connection outright.
          try { await physical.close?.(); } catch { /* ignore */ }
        } else {
          // Pooled branch: return the connection to the pool so the next
          // checkout reuses it (no new signon).
          try { pool.release(physical); } catch { /* ignore */ }
        }
      },
      addConnectionEventListener(l) { if (l) listeners.connection.push(l); },
      removeConnectionEventListener(l) {
        listeners.connection = listeners.connection.filter(x => x !== l);
      },
      // Statement listeners are accepted for JDBC shape parity but
      // no `statementClosed` / `statementErrorOccurred` events are
      // emitted today. Callers that rely on these events will see
      // nothing — do not depend on them until the Statement layer
      // starts firing events. This is intentional and documented
      // in docs/sql-feature-matrix.md.
      addStatementEventListener(l) { if (l) listeners.statement.push(l); },
      removeStatementEventListener(l) {
        listeners.statement = listeners.statement.filter(x => x !== l);
      },
    };
    return wrapper;
  }
}

/**
 * Install get/set property methods on a DataSource subclass to match the
 * JTOpen naming convention. Setters translate `setFooBar(v)` to
 * `setProperty('fooBar', v)` and getters mirror the symmetric read.
 *
 * We do this via a prototype walk so every known JTOpen property gets a
 * typed setter / getter pair without defining each method by hand.
 */
function installPropertyAccessors(ctor) {
  for (const name of KNOWN_JTOPEN_PROPERTIES) {
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    const setter = `set${cap}`;
    const getter = `get${cap}`;
    if (!ctor.prototype[setter]) {
      ctor.prototype[setter] = function(v) { this.setProperty(name, v); return this; };
    }
    if (!ctor.prototype[getter]) {
      ctor.prototype[getter] = function() { return this.getProperty(name); };
    }
  }
}

installPropertyAccessors(DataSource);
installPropertyAccessors(ConnectionPoolDataSource);
