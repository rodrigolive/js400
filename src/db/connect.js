/**
 * Database connection factory and JDBC URL parser.
 *
 * Provides the top-level `sql.connect()` and `sql.createPool()` APIs
 * that accept both JDBC URLs and JS option objects.
 *
 * Upstream: AS400JDBCDriver.java, JDDataSourceURL.java
 * @module db/connect
 */

import { DbConnection } from './engine/DbConnection.js';
import { Connection } from './api/Connection.js';
import { ConnectionPool } from './pool/ConnectionPool.js';
import { parseJdbcUrl as parseJdbcUrlImpl } from './url.js';
import { normalizeProperties, validateProperties } from './properties.js';

/**
 * Connect to an IBM i database.
 *
 * Accepts either:
 * - An AS400 system instance + options: `connect(system, opts)`
 * - A JDBC URL string: `connect("jdbc:as400://host/schema;...")`
 * - An options object with host/user/password: `connect({ host, user, password, ... })`
 *
 * @param {import('../core/AS400.js').AS400|string|object} systemOrUrl
 * @param {object} [opts] - connection properties (naming, libraries, etc.)
 * @returns {Promise<Connection>}
 */
export async function connect(systemOrUrl, opts = {}) {
  let connOpts;

  if (typeof systemOrUrl === 'string') {
    // JDBC URL
    connOpts = parseJdbcUrlImpl(systemOrUrl);
    Object.assign(connOpts, opts);
  } else if (systemOrUrl && typeof systemOrUrl === 'object' && !systemOrUrl.connectService) {
    // Plain options object
    connOpts = { ...systemOrUrl, ...opts };
  } else {
    // AS400 system instance
    const normalized = normalizeProperties(opts);
    const db = new DbConnection(systemOrUrl, normalized);
    await db.connect();
    return new Connection(db);
  }

  // For URL/options-based connect, we need an AS400 system
  // If the caller provided host/user/password, we import AS400 lazily
  if (connOpts.host) {
    const { AS400 } = await import('../core/AS400.js');
    const system = new AS400({
      host: connOpts.host,
      user: connOpts.user,
      password: connOpts.password,
      port: connOpts.port,
      secure: connOpts.secure ?? false,
    });
    await system.connect();
    const normalized = normalizeProperties(connOpts);
    const db = new DbConnection(system, normalized);
    await db.connect();
    return new Connection(db);
  }

  throw new Error('Cannot connect: provide an AS400 instance, JDBC URL, or options with host/user/password');
}

/**
 * Create a connection pool.
 *
 * @param {object} options
 * @param {string} [options.host]
 * @param {string} [options.user]
 * @param {string} [options.password]
 * @param {number} [options.max=10]
 * @param {number} [options.min=0]
 * @param {number} [options.idleTimeout=60000]
 * @param {string[]} [options.libraries]
 * @returns {ConnectionPool}
 */
export function createPool(options = {}) {
  return new ConnectionPool({
    ...options,
    connect: () => connect({
      host: options.host,
      user: options.user,
      password: options.password,
      port: options.port,
      secure: options.secure,
      libraries: options.libraries,
      naming: options.naming,
      dateFormat: options.dateFormat,
      timeFormat: options.timeFormat,
      defaultSchema: options.defaultSchema,
    }),
  });
}

/**
 * Parse a JDBC-style URL into connection options.
 * @param {string} url
 * @returns {object}
 */
export function parseJdbcUrl(url) {
  return parseJdbcUrlImpl(url);
}
