/**
 * JDBC URL parser helpers.
 *
 * Parses JTOpen-style JDBC URLs for migration convenience:
 *   jdbc:as400://host/defaultSchema;prop1=value1;prop2=value2
 *
 * Upstream: JDDataSourceURL.java
 * @module db/url
 */

/**
 * Map of JDBC property names to js400 option names.
 * Keys are lowercase for case-insensitive matching.
 */
const JDBC_PROP_MAP = {
  'user':              'user',
  'password':          'password',
  'secure':            'secure',
  'naming':            'naming',
  'libraries':         'libraries',
  'database name':     'defaultSchema',
  'default collection':'defaultSchema',
  'date format':       'dateFormat',
  'date separator':    'dateSeparator',
  'time format':       'timeFormat',
  'time separator':    'timeSeparator',
  'decimal separator': 'decimalSeparator',
  'sort':              'sortType',
  'sort language':     'sortLanguage',
  'sort table':        'sortTable',
  'sort weight':       'sortWeight',
  'transaction isolation': 'isolation',
  'auto commit':       'autoCommit',
  'block criteria':    'blockCriteria',
  'block size':        'blockSize',
  'prefetch':          'prefetch',
  'lazy close':        'lazyClose',
  'package':           'sqlPackage',
  'package library':   'packageLibrary',
  'package cache':     'packageCache',
  'translate binary':  'translateBinary',
  'true autocommit':   'trueAutoCommit',
};

/**
 * Normalize a JDBC date format value to a js400 DateFormat constant.
 */
function normalizeDateFormat(val) {
  const v = val.toLowerCase().replace(/^\*/, '');
  const map = {
    'iso': '*ISO', 'usa': '*USA', 'eur': '*EUR', 'jis': '*JIS',
    'mdy': '*MDY', 'dmy': '*DMY', 'ymd': '*YMD', 'jul': '*JUL',
  };
  return map[v] || val;
}

/**
 * Normalize a JDBC time format value.
 */
function normalizeTimeFormat(val) {
  const v = val.toLowerCase().replace(/^\*/, '');
  const map = {
    'iso': '*ISO', 'usa': '*USA', 'eur': '*EUR', 'jis': '*JIS',
    'hms': '*HMS',
  };
  return map[v] || val;
}

/**
 * Normalize a property value based on its key.
 */
function normalizeValue(key, val) {
  switch (key) {
    case 'secure':
    case 'autoCommit':
    case 'prefetch':
    case 'lazyClose':
    case 'translateBinary':
    case 'trueAutoCommit':
    case 'packageCache':
      return val === 'true' || val === '1' || val === 'yes';
    case 'blockSize':
      return parseInt(val, 10) || 32;
    case 'libraries':
      return val.split(',').map(s => s.trim()).filter(Boolean);
    case 'naming':
      return val.toLowerCase() === 'system' ? 'system' : 'sql';
    case 'dateFormat':
      return normalizeDateFormat(val);
    case 'timeFormat':
      return normalizeTimeFormat(val);
    default:
      return val;
  }
}

/**
 * Parse a JDBC-style URL into a js400 connection options object.
 *
 * Format: jdbc:as400://host[:port]/defaultSchema;prop1=value1;prop2=value2
 *
 * @param {string} url
 * @returns {object} connection options
 */
export function parseJdbcUrl(url) {
  if (typeof url !== 'string') {
    throw new Error('Expected a JDBC URL string');
  }

  const trimmed = url.trim();

  // Accept both jdbc:as400:// and jdbc:as400:
  if (!trimmed.startsWith('jdbc:as400:')) {
    throw new Error('Expected a jdbc:as400:// URL');
  }

  // Strip the jdbc:as400:// prefix
  let rest = trimmed.slice('jdbc:as400:'.length);
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
  }

  const result = {
    protocol: 'jdbc:as400',
  };

  // Split host+path from properties (separated by ;)
  const semiIdx = rest.indexOf(';');
  let hostPath;
  let propString = '';

  if (semiIdx >= 0) {
    hostPath = rest.slice(0, semiIdx);
    propString = rest.slice(semiIdx + 1);
  } else {
    hostPath = rest;
  }

  // Parse host[:port][/defaultSchema]
  const slashIdx = hostPath.indexOf('/');
  let hostPort;
  if (slashIdx >= 0) {
    hostPort = hostPath.slice(0, slashIdx);
    const schema = hostPath.slice(slashIdx + 1).trim();
    if (schema) {
      result.defaultSchema = schema;
    }
  } else {
    hostPort = hostPath;
  }

  // Parse host:port
  const colonIdx = hostPort.lastIndexOf(':');
  if (colonIdx > 0) {
    result.host = hostPort.slice(0, colonIdx);
    const port = parseInt(hostPort.slice(colonIdx + 1), 10);
    if (!isNaN(port) && port > 0) {
      result.port = port;
    }
  } else {
    result.host = hostPort;
  }

  // Parse semicolon-separated properties
  if (propString) {
    const pairs = propString.split(';');
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx < 0) continue;

      const rawKey = pair.slice(0, eqIdx).trim();
      const rawVal = pair.slice(eqIdx + 1).trim();

      if (!rawKey) continue;

      const mappedKey = JDBC_PROP_MAP[rawKey.toLowerCase()];
      if (mappedKey) {
        result[mappedKey] = normalizeValue(mappedKey, rawVal);
      } else {
        // Keep unknown properties with original key
        result[rawKey] = rawVal;
      }
    }
  }

  return result;
}

/**
 * Parse a JDBC URL into its raw parts without normalization.
 * @param {string} url
 * @returns {object}
 */
export function parseJdbcUrlParts(url) {
  if (typeof url !== 'string') {
    throw new Error('Expected a JDBC URL string');
  }

  const parsed = parseJdbcUrl(url);
  return {
    raw: url,
    ...parsed,
  };
}
