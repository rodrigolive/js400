/**
 * System property defaults.
 *
 * Provides default configuration values that can be overridden
 * by environment variables or options passed to AS400 constructors.
 *
 * Upstream: SystemProperties.java
 * @module internal/SystemProperties
 */

export const SYSTEM_PROPERTIES = Object.freeze({
  /** Default connection timeout in milliseconds. */
  'com.ibm.as400.access.AS400.socketTimeout': 30000,

  /** Default port mapper timeout in milliseconds. */
  'com.ibm.as400.access.AS400.portMapperTimeout': 10000,

  /** Whether to use TLS by default. */
  'com.ibm.as400.access.SecureAS400.useSSL': false,

  /** Whether to reject unauthorized TLS certificates. */
  'com.ibm.as400.access.SecureAS400.rejectUnauthorized': true,

  /** Default pool max connections. */
  'com.ibm.as400.access.ConnectionPool.max': 10,

  /** Default pool idle timeout in ms. */
  'com.ibm.as400.access.ConnectionPool.idleTimeout': 60000,

  /** Whether tracing is on by default. */
  'com.ibm.as400.access.Trace.on': false,

  /** Trace categories to enable (comma-separated). */
  'com.ibm.as400.access.Trace.category': '',

  /** Trace file path. */
  'com.ibm.as400.access.Trace.file': '',

  /** Default CCSID. 0 means use the server's default. */
  'com.ibm.as400.access.AS400.ccsid': 0,

  /** Whether to use threads (not applicable in JS, kept for compat). */
  'com.ibm.as400.access.AS400.threadUsed': false,

  /** Socket keep-alive. */
  'com.ibm.as400.access.AS400.socketKeepAlive': true,

  /** TCP no delay. */
  'com.ibm.as400.access.AS400.socketTcpNoDelay': true,
});

/**
 * Get a system property value, checking environment variables first.
 *
 * Environment variable names are derived by replacing dots with underscores
 * and uppercasing.
 *
 * @param {string} key
 * @param {*} [defaultValue]
 * @returns {*}
 */
export function getSystemProperty(key, defaultValue) {
  // Check environment variable
  const envKey = key.replace(/\./g, '_').toUpperCase();
  const envVal = typeof process !== 'undefined' ? process.env?.[envKey] : undefined;

  if (envVal !== undefined) {
    // Attempt type coercion based on default value type
    const defVal = defaultValue ?? SYSTEM_PROPERTIES[key];
    if (typeof defVal === 'number') {
      const n = Number(envVal);
      if (!isNaN(n)) return n;
    }
    if (typeof defVal === 'boolean') {
      return envVal === 'true' || envVal === '1';
    }
    return envVal;
  }

  if (defaultValue !== undefined) return defaultValue;
  return SYSTEM_PROPERTIES[key];
}
