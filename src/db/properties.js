/**
 * Connection property registry and constants for the database server.
 *
 * Upstream: JDProperties.java
 * @module db/properties
 */

/** Naming conventions for SQL object resolution. */
export const Naming = Object.freeze({
  SQL:    'sql',    // schema.table
  SYSTEM: 'system', // library/file
});

/** Date format constants sent to the server. */
export const DateFormat = Object.freeze({
  ISO:  '*ISO',
  USA:  '*USA',
  EUR:  '*EUR',
  JIS:  '*JIS',
  MDY:  '*MDY',
  DMY:  '*DMY',
  YMD:  '*YMD',
  JUL:  '*JUL',
});

/** Time format constants. */
export const TimeFormat = Object.freeze({
  ISO: '*ISO',
  USA: '*USA',
  EUR: '*EUR',
  JIS: '*JIS',
  HMS: '*HMS',
});

/** Date separator constants. */
export const DateSeparator = Object.freeze({
  SLASH:  '/',
  DASH:   '-',
  PERIOD: '.',
  COMMA:  ',',
  SPACE:  ' ',
});

/** Time separator constants. */
export const TimeSeparator = Object.freeze({
  COLON:  ':',
  PERIOD: '.',
  COMMA:  ',',
  SPACE:  ' ',
});

/** Decimal separator constants. */
export const DecimalSeparator = Object.freeze({
  PERIOD: '.',
  COMMA:  ',',
});

/** Sort sequence constants. */
export const SortSequenceType = Object.freeze({
  HEX:    '*HEX',
  JOB:    '*JOB',
  LANGIDUNQ: '*LANGIDUNQ',
  LANGIDSHR: '*LANGIDSHR',
  TABLE:  'table',
});

/** Transaction isolation levels. */
export const IsolationLevel = Object.freeze({
  NONE:             'none',
  READ_UNCOMMITTED: 'read-uncommitted',
  READ_COMMITTED:   'read-committed',
  REPEATABLE_READ:  'repeatable-read',
  SERIALIZABLE:     'serializable',
});

/** Commit mode values sent on the wire (maps to JTOpen values). */
export const CommitMode = Object.freeze({
  NONE:             0xF0,   // *NONE — no commitment control
  READ_UNCOMMITTED: 0xF1,   // *CHG
  READ_COMMITTED:   0xF2,   // *CS
  REPEATABLE_READ:  0xF3,   // *ALL
  SERIALIZABLE:     0xF4,   // *RR
});

/** Maps IsolationLevel strings to CommitMode wire values. */
export const IsolationToCommitMode = Object.freeze({
  [IsolationLevel.NONE]:             CommitMode.NONE,
  [IsolationLevel.READ_UNCOMMITTED]: CommitMode.READ_UNCOMMITTED,
  [IsolationLevel.READ_COMMITTED]:   CommitMode.READ_COMMITTED,
  [IsolationLevel.REPEATABLE_READ]:  CommitMode.REPEATABLE_READ,
  [IsolationLevel.SERIALIZABLE]:     CommitMode.SERIALIZABLE,
});

/** Default connection properties. */
export const defaultProperties = Object.freeze({
  naming:           Naming.SQL,
  libraries:        [],
  dateFormat:       DateFormat.ISO,
  timeFormat:       TimeFormat.ISO,
  dateSeparator:    DateSeparator.DASH,
  timeSeparator:    TimeSeparator.COLON,
  decimalSeparator: DecimalSeparator.PERIOD,
  isolation:        IsolationLevel.READ_UNCOMMITTED,
  autoCommit:       true,
  blockSize:        32,
  prefetch:         true,
  lazyClose:        false,
  translateBinary:  false,
  trueAutoCommit:   false,
});

/** Legacy export for backward compatibility. */
export const connectionProperties = defaultProperties;

/** Known P0/P1 property names for validation. */
const KNOWN_PROPERTIES = new Set([
  'naming', 'libraries', 'defaultSchema',
  'dateFormat', 'dateSeparator', 'timeFormat', 'timeSeparator',
  'decimalSeparator', 'isolation', 'autoCommit',
  'blockSize', 'prefetch', 'lazyClose', 'translateBinary', 'trueAutoCommit',
  'sortType', 'sortLanguage', 'sortTable', 'sortWeight', 'sortSequence',
  'host', 'port', 'user', 'password', 'secure', 'protocol',
  'sqlPackage', 'packageLibrary', 'packageCache',
  'blockCriteria',
]);

/** Valid values for enum-style properties. */
const VALID_NAMING = new Set(['sql', 'system']);
const VALID_DATE_FORMATS = new Set(['*ISO', '*USA', '*EUR', '*JIS', '*MDY', '*DMY', '*YMD', '*JUL']);
const VALID_TIME_FORMATS = new Set(['*ISO', '*USA', '*EUR', '*JIS', '*HMS']);
const VALID_ISOLATION = new Set([
  'none', 'read-uncommitted', 'read-committed', 'repeatable-read', 'serializable',
]);

/**
 * Validate connection properties. Throws on invalid values.
 * @param {object} props
 * @returns {string[]} warnings for unknown properties
 */
export function validateProperties(props) {
  const warnings = [];

  for (const key of Object.keys(props)) {
    if (!KNOWN_PROPERTIES.has(key)) {
      warnings.push(`Unknown connection property: "${key}"`);
    }
  }

  if (props.naming !== undefined && !VALID_NAMING.has(props.naming)) {
    throw new Error(`Invalid naming value: "${props.naming}". Expected "sql" or "system".`);
  }

  if (props.dateFormat !== undefined && !VALID_DATE_FORMATS.has(props.dateFormat)) {
    throw new Error(`Invalid dateFormat: "${props.dateFormat}". Expected one of: ${[...VALID_DATE_FORMATS].join(', ')}`);
  }

  if (props.timeFormat !== undefined && !VALID_TIME_FORMATS.has(props.timeFormat)) {
    throw new Error(`Invalid timeFormat: "${props.timeFormat}". Expected one of: ${[...VALID_TIME_FORMATS].join(', ')}`);
  }

  if (props.isolation !== undefined && !VALID_ISOLATION.has(props.isolation)) {
    throw new Error(`Invalid isolation: "${props.isolation}". Expected one of: ${[...VALID_ISOLATION].join(', ')}`);
  }

  if (props.libraries !== undefined && !Array.isArray(props.libraries)) {
    throw new Error('libraries must be an array of strings');
  }

  if (props.blockSize !== undefined) {
    const bs = props.blockSize;
    if (typeof bs !== 'number' || bs < 0 || bs > 512) {
      throw new Error(`Invalid blockSize: ${bs}. Expected 0-512.`);
    }
  }

  return warnings;
}

/**
 * Merge user properties with defaults, normalizing where needed.
 * @param {object} userProps
 * @returns {object}
 */
export function normalizeProperties(userProps) {
  const merged = { ...defaultProperties, ...userProps };

  // Ensure libraries is always an array
  if (typeof merged.libraries === 'string') {
    merged.libraries = merged.libraries.split(',').map(s => s.trim()).filter(Boolean);
  }

  // Normalize boolean strings
  for (const key of ['autoCommit', 'prefetch', 'lazyClose', 'translateBinary', 'trueAutoCommit', 'secure']) {
    if (typeof merged[key] === 'string') {
      merged[key] = merged[key] === 'true' || merged[key] === '1';
    }
  }

  return merged;
}
