/**
 * SQL package handling.
 *
 * Manages server-side SQL packages that cache prepared statement access
 * plans. Mirrors JTOpen `JDPackageManager`:
 *
 *   - Gated by `extendedDynamic`; disabled when `sqlPackage` is empty.
 *   - Package name is normalized to up-to-6 chars of name + 4-char
 *     suffix, with the suffix encoding the connection's commit mode,
 *     date/time format+separator, decimal separator, naming convention,
 *     and translate-hex choice. This matches JTOpen byte-for-byte so
 *     existing server-side packages are interchangeable across JTOpen
 *     and js400 clients.
 *   - Library defaults to `QGPL` if unset.
 *   - Package failures honor a three-value `packageError` policy:
 *     `none` (silent disable), `warning` (disable + queue a warning
 *     for the connection's warning chain), `exception` (throw from
 *     the prepare/execute path).
 *   - On the default path (extendedDynamic off) the manager is a
 *     no-op and every hot-path check collapses to one boolean read.
 *
 * Upstream:
 *   - JDPackageManager.java (enable rules, normalization, create/cache)
 *   - JDSQLStatement.java#analyzeBody (isPackaged heuristic)
 *   - JDProperties.java#choices (property-index tables)
 *
 * @module db/engine/PackageManager
 */

import { SqlWarning } from '../api/SqlWarning.js';

/**
 * Same invariant JTOpen uses for suffix character generation; kept
 * identical so names stay interchangeable with JTOpen clients.
 */
const SUFFIX_INVARIANT =
  '9876543210ZYXWVUTSRQPONMLKJIHGFEDCBA';

/**
 * How JTOpen maps the user-facing `packageError` property onto
 * exception vs warning when a package operation fails. Values
 * mirror the JTOpen strings exactly so user-supplied
 * `packageError="exception"` etc keep working.
 */
export const PackageErrorPolicy = Object.freeze({
  NONE: 'none',
  WARNING: 'warning',
  EXCEPTION: 'exception',
});

/**
 * JTOpen `JDProperties` choice-order tables. Index matters — JTOpen's
 * suffix formula indexes SUFFIX_INVARIANT_ using these exact values,
 * and the server's package stores its metadata using these same
 * ordinals. Derived directly from JDProperties.java.
 */
const DATE_FORMAT_INDEX = Object.freeze({
  julian: 0,
  mdy:    1,
  dmy:    2,
  ymd:    3,
  usa:    4,
  iso:    5,
  eur:    6,
  jis:    7,
});
const DATE_SEPARATOR_INDEX = Object.freeze({
  '/': 0,
  '-': 1,
  '.': 2,
  ',': 3,
  ' ': 4,
});
const TIME_FORMAT_INDEX = Object.freeze({
  hms: 0,
  usa: 1,
  iso: 2,
  eur: 3,
  jis: 4,
});
const TIME_SEPARATOR_INDEX = Object.freeze({
  ':': 0,
  '.': 1,
  ',': 2,
  ' ': 3,
});
const DECIMAL_SEPARATOR_INDEX = Object.freeze({
  '.': 0,
  ',': 1,
});
const NAMING_INDEX = Object.freeze({
  sql:    0,
  system: 1,
});
const TRANSLATE_HEX_INDEX = Object.freeze({
  character: 0,
  binary:    1,
});

/**
 * Commit-mode ordinals as JTOpen's JDTransactionManager exposes them
 * via `getCommitMode()`. These are the 0-4 values that the package
 * suffix's RR remap branch depends on, NOT the 0xF0..0xF4 wire bytes.
 */
export const PackageCommitMode = Object.freeze({
  NONE:             0,   // *NONE
  CHG:              1,   // *CHG / READ_UNCOMMITTED
  CS:               2,   // *CS / READ_COMMITTED
  ALL:              3,   // *ALL / REPEATABLE_READ
  RR:               4,   // *RR / SERIALIZABLE (the special one)
});

/**
 * Map the user-facing `isolation` string to a JTOpen 0-4 commit-mode
 * index. Exported for the test suite and for any caller that wants
 * to compute a suffix without DbConnection in the loop.
 */
export function isolationToCommitMode(isolation) {
  switch (isolation) {
    case 'none':             return PackageCommitMode.NONE;
    case 'read-uncommitted': return PackageCommitMode.CHG;
    case 'read-committed':   return PackageCommitMode.CS;
    case 'repeatable-read':  return PackageCommitMode.ALL;
    case 'serializable':     return PackageCommitMode.RR;
    default:                 return PackageCommitMode.CS;
  }
}

/**
 * Translate a user-facing `*ISO`-style date/time format string into
 * the lowercase token JTOpen indexes into DATE_FORMAT_INDEX /
 * TIME_FORMAT_INDEX. Accepts either `*ISO` or `iso` (case-insensitive).
 */
function normalizeFormatToken(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (s.startsWith('*')) s = s.slice(1);
  return s.toLowerCase();
}

/**
 * Build the JTOpen-shaped `suffixCtx` (the bag of property-index
 * values) from the user's connection properties and the current
 * commit mode. Keeping this in one place so `normalizeName` stays
 * pure and tests can feed it deterministic input.
 *
 * @param {object} props - normalized connection properties bag
 *   (keys: `dateFormat`, `dateSeparator`, `timeFormat`,
 *    `timeSeparator`, `decimalSeparator`, `naming`, `translateHex`,
 *    `isolation`). Unset values fall back to JTOpen defaults.
 * @param {number|string} [commitMode] - 0..4 index OR an isolation
 *   string.
 * @returns {object} suffixCtx consumed by `normalizeName`
 */
export function deriveSuffixContext(props = {}, commitMode) {
  const cm = typeof commitMode === 'number'
    ? commitMode | 0
    : isolationToCommitMode(
      commitMode ?? props.isolation ?? 'read-committed',
    );

  const df = DATE_FORMAT_INDEX[normalizeFormatToken(props.dateFormat)] ?? 5; // iso
  const ds = DATE_SEPARATOR_INDEX[props.dateSeparator] ?? 1; // '-'
  const tf = TIME_FORMAT_INDEX[normalizeFormatToken(props.timeFormat)] ?? 2; // iso
  const ts = TIME_SEPARATOR_INDEX[props.timeSeparator] ?? 0; // ':'
  const ds0 = DECIMAL_SEPARATOR_INDEX[props.decimalSeparator] ?? 0; // '.'
  const nm = NAMING_INDEX[props.naming] ?? 0; // sql
  const th = typeof props.translateHex === 'string'
    ? (TRANSLATE_HEX_INDEX[props.translateHex.toLowerCase()] ?? 0)
    : (props.translateHex ? 1 : 0);

  return {
    commitMode:       cm,
    dateFormat:       df,
    dateSeparator:    ds,
    timeFormat:       tf,
    timeSeparator:    ts,
    decimalSeparator: ds0,
    naming:           nm,
    translateHex:     th,
  };
}

export class PackageManager {
  #enabled;
  #cache;
  #name;
  #libraryName;
  #errorPolicy;
  #created;
  #cachedRaw;
  #cachedStatementCount;
  #lastError;
  #pendingWarning;
  #rpbId;
  #metrics;

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.extendedDynamic=false]
   * @param {boolean} [opts.packageCache=false]
   * @param {string|null} [opts.packageName=null] — user-supplied name.
   *   When absent, the manager stays disabled even if
   *   `extendedDynamic` is true, matching JTOpen's
   *   `WARN_EXTENDED_DYNAMIC_DISABLED` path.
   * @param {string|null} [opts.packageLibrary=null] — defaults to QGPL.
   * @param {string} [opts.errorPolicy='warning'] — policy string;
   *   mirrors JTOpen's `package error` property (none/warning/exception).
   * @param {object} [opts.suffixContext] — JTOpen-shape indexes for
   *   the 4-char suffix. Build via `deriveSuffixContext()` from the
   *   caller's properties + commit mode.
   * @param {number} [opts.rpbId] — connection-scoped RPB id to use
   *   for CREATE_PACKAGE / RETURN_PACKAGE. Mirrors JTOpen's
   *   connection `id_`. When unset, falls back to 0.
   */
  constructor(opts = {}) {
    this.#enabled = false;
    this.#cache = Boolean(opts.packageCache);
    this.#libraryName = null;
    this.#name = null;
    this.#errorPolicy = normalizeErrorPolicy(opts.errorPolicy);
    this.#created = false;
    this.#cachedRaw = null;
    this.#cachedStatementCount = 0;
    this.#lastError = null;
    this.#pendingWarning = null;
    this.#rpbId = Number.isFinite(opts.rpbId) ? (opts.rpbId | 0) : 0;
    this.#metrics = {
      packageCreates: 0,
      packageFetches: 0,
      packageHits: 0,
    };

    if (!opts.extendedDynamic) return;

    const rawName = typeof opts.packageName === 'string'
      ? opts.packageName.trim()
      : '';
    if (rawName.length === 0) {
      // JTOpen posts WARN_EXTENDED_DYNAMIC_DISABLED here.
      this.#lastError = 'package name is required when extendedDynamic is enabled';
      return;
    }

    const lib = typeof opts.packageLibrary === 'string' && opts.packageLibrary.trim().length > 0
      ? opts.packageLibrary.trim().toUpperCase()
      : 'QGPL';

    this.#libraryName = lib;
    this.#name = PackageManager.normalizeName(rawName, opts.suffixContext);
    this.#enabled = true;
  }

  /**
   * Exact port of JTOpen `JDPackageManager.getSuffix` +
   * normalization. Input is:
   *   - `rawName`          : the user's `sqlPackage` value
   *   - `suffixCtx`        : the index bag from
   *                          `deriveSuffixContext(...)` with numeric
   *                          0-based indexes matching JDProperties
   *                          choice order
   *
   * Algorithm (mirrors JTOpen):
   *   - Name body: if ≥ 6 chars, truncate to 6; else use raw length.
   *     Uppercase and replace spaces with underscores.
   *   - Suffix char 1: invariant[translateHex]
   *   - Suffix char 2: invariant[(commitMode << 3) | dateFormat], but
   *     when commitMode == 4 (*RR) the two bits don't fit in this slot
   *     so JTOpen remaps dateSep into slot 2 and stores commitMode in
   *     the dateSep range (0..2 → dateSep 6, 3..4 → dateSep 7).
   *   - Suffix char 3: invariant[(decimalSep << 4) | (naming << 3) |
   *                              dateSep]
   *   - Suffix char 4: invariant[(timeFormat << 2) | timeSeparator]
   *
   * Known ordering / precedence caveats match the JTOpen source —
   * tests assert these byte-for-byte.
   */
  static normalizeName(rawName, suffixCtx = {}) {
    const base = (String(rawName).length >= 6
      ? String(rawName).slice(0, 6)
      : String(rawName)
    ).toUpperCase().replace(/ /g, '_');

    // Indexes — each defaults to 0 so a caller who passes no context
    // gets the all-zero suffix (valid, just not cross-client
    // compatible with different settings).
    const clamp = (v, max) => {
      const n = (v | 0);
      return n < 0 ? 0 : (n > max ? max : n);
    };
    const translateHex     = clamp(suffixCtx.translateHex,     1);
    const dateFormat       = clamp(suffixCtx.dateFormat,       7);
    let   dateSeparator    = clamp(suffixCtx.dateSeparator,    4);
    const decimalSeparator = clamp(suffixCtx.decimalSeparator, 1);
    const naming           = clamp(suffixCtx.naming,           1);
    const timeFormat       = clamp(suffixCtx.timeFormat,       4);
    const timeSeparator    = clamp(suffixCtx.timeSeparator,    3);
    let   commitMode       = clamp(suffixCtx.commitMode,       4);

    // RR remap (JDPackageManager.getSuffix @G0A): *RR (commitMode=4)
    // doesn't fit in the 2 commit-mode bits, so JTOpen repurposes
    // unused dateSep values 5-7 to carry the RR commit mode, then
    // stores the real dateSep in the commitMode slot. This preserves
    // a bijection — given the suffix char you can always recover
    // (commitMode, dateSep).
    if (commitMode === PackageCommitMode.RR) {
      switch (dateSeparator) {
        case 0: case 1: case 2:
          commitMode = dateSeparator;
          dateSeparator = 6;
          break;
        case 3: case 4:
          commitMode = dateSeparator - 2;
          dateSeparator = 7;
          break;
        default:
          // 5-7 are reserved for RR encoding; if we ever get here
          // with a raw value outside 0-4, fall through.
          break;
      }
    }

    const invariant = SUFFIX_INVARIANT;
    const invLen = invariant.length;
    const safeCharAt = (idx) => invariant.charAt(((idx | 0) % invLen + invLen) % invLen);

    const ch1 = safeCharAt(translateHex);
    const ch2 = safeCharAt((commitMode << 3) | dateFormat);
    const ch3 = safeCharAt((decimalSeparator << 4)
                         | (naming << 3)
                         | dateSeparator);
    const ch4 = safeCharAt((timeFormat << 2) | timeSeparator);

    return base + ch1 + ch2 + ch3 + ch4;
  }

  get metrics() { return this.#metrics; }
  get rpbId() { return this.#rpbId; }

  isEnabled() { return this.#enabled; }
  isCreated() { return this.#created; }
  isCached() { return this.#cachedRaw !== null; }

  getName() { return this.#name; }
  getLibraryName() { return this.#libraryName; }
  getErrorPolicy() { return this.#errorPolicy; }
  getCachedRaw() { return this.#cachedRaw; }
  getCachedStatementCount() { return this.#cachedStatementCount; }
  getLastError() { return this.#lastError; }
  isCacheRequested() { return this.#cache; }

  /**
   * Mark that a CREATE_PACKAGE round trip completed (or that the
   * package already exists, which JTOpen treats identically for the
   * purpose of isCreated()).
   */
  markCreated() {
    this.#created = true;
    this.#metrics.packageCreates++;
  }

  /**
   * Record a cached package payload fetched via RETURN_PACKAGE. The
   * raw buffer is kept opaque for now; once we teach
   * `DBReplyPackageInfo` to decode statement names + data formats,
   * the cache-hit skip-prepare path can pull from here.
   */
  setCachedRaw(buf, statementCount = 0) {
    this.#cachedRaw = buf ?? null;
    this.#cachedStatementCount = statementCount | 0;
    this.#metrics.packageFetches++;
  }

  /** Record a cached-statement lookup that reused a packaged name. */
  recordHit() {
    this.#metrics.packageHits++;
  }

  /**
   * Disable the manager and capture why. Used when the server refuses
   * or when the client downgrades due to an explicit `packageError`
   * policy.
   */
  disable(reason) {
    this.#enabled = false;
    this.#lastError = typeof reason === 'string' ? reason : null;
  }

  /**
   * Report a package failure. Honors `packageError`:
   *   - `'exception'` → throw a SqlError-shape error; caller must
   *     propagate. The manager is also disabled so subsequent
   *     retries don't hit the same failure.
   *   - `'warning'`   → disable + queue a SqlWarning on the
   *     manager for the api Connection to drain at the next prepare
   *     boundary.
   *   - `'none'`      → silent disable.
   *
   * Returns the queued warning (if any) so callers that want to
   * propagate it eagerly can do so.
   */
  reportFailure(reason, { sqlState = '01000', vendorCode = 0 } = {}) {
    const msg = typeof reason === 'string' ? reason : 'SQL package failure';
    this.disable(msg);

    if (this.#errorPolicy === PackageErrorPolicy.EXCEPTION) {
      const err = new Error(msg);
      err.sqlState = sqlState;
      err.vendorCode = vendorCode;
      err.packagePolicy = PackageErrorPolicy.EXCEPTION;
      throw err;
    }
    if (this.#errorPolicy === PackageErrorPolicy.WARNING) {
      const w = new SqlWarning(msg, { sqlState, vendorCode });
      this.#pendingWarning = w;
      return w;
    }
    return null;
  }

  /**
   * Drain the queued warning (if any). Called by DbConnection after
   * each engine-level prepare/execute so the api Connection can
   * graft it onto its warning chain without the engine layer having
   * to know about Connection/Statement identity.
   */
  takeWarning() {
    const w = this.#pendingWarning;
    this.#pendingWarning = null;
    return w;
  }

  /**
   * Decide whether a given SQL string is "packageable" in the sense
   * JTOpen uses. Mirrors `JDSQLStatement#analyzeBody` (2011-11-29
   * revision):
   *
   *   isPackaged =   ((numberOfParameters > 0) && !isCurrentOf)
   *               || (isInsert && isSubSelect)
   *               || (isSelect && isForUpdate)
   *               || (isDeclare)
   *
   * The parameter count and keyword detection use a proper SQL
   * tokenizer that skips:
   *   - `--` line comments
   *   - `/* ... *\/` block comments
   *   - `'...'` string literals (including `''` escape)
   *   - `"..."` double-quoted identifiers (including `""` escape)
   *
   * so `?` inside a literal or identifier is NOT counted as a
   * parameter marker.
   */
  isPackaged(sql) {
    if (!this.#enabled) return false;
    const scan = tokenizeForPackage(String(sql ?? ''));
    if (!scan) return false;

    const hasParameter = scan.paramMarkers > 0;
    const first = scan.firstKeyword;
    const isCurrentOf = scan.hasCurrentOf;
    const isInsert = first === 'INSERT';
    const isSubSelect = isInsert && scan.hasSelect;
    const isSelect = first === 'SELECT' || first === 'WITH' || first === 'VALUES';
    const isForUpdate = isSelect && scan.hasForUpdate;
    const isDeclare = first === 'DECLARE';

    return (hasParameter && !isCurrentOf)
      || (isInsert && isSubSelect)
      || (isSelect && isForUpdate)
      || isDeclare;
  }

  /**
   * Reset recorded state to the initial disabled form. Used by tests
   * and by pool-lifecycle code that rebuilds per-connection managers.
   */
  reset() {
    this.#created = false;
    this.#cachedRaw = null;
    this.#cachedStatementCount = 0;
    this.#lastError = null;
    this.#pendingWarning = null;
  }
}

/**
 * Canonicalize user-supplied `packageError` strings onto the three
 * JTOpen policy values. Unknown strings default to `'warning'` to
 * match JTOpen's default (`PACKAGE_ERROR_WARNING`).
 */
function normalizeErrorPolicy(value) {
  if (typeof value !== 'string') return PackageErrorPolicy.WARNING;
  switch (value.toLowerCase()) {
    case 'none':      return PackageErrorPolicy.NONE;
    case 'exception': return PackageErrorPolicy.EXCEPTION;
    case 'warning':   return PackageErrorPolicy.WARNING;
    default:          return PackageErrorPolicy.WARNING;
  }
}

/**
 * Minimal SQL tokenizer used for package eligibility. Walks the SQL
 * byte-by-byte, tracking:
 *   - `firstKeyword`   : first non-comment, non-parenthesis bareword
 *                        (uppercased) — used to detect SELECT/INSERT/
 *                        DECLARE.
 *   - `paramMarkers`   : count of `?` characters OUTSIDE quoted
 *                        sections and comments. A standalone `?=`
 *                        prefix (JDBC function-return form) is
 *                        stripped before counting so it doesn't
 *                        inflate the marker count.
 *   - `isReturnFunction`: true when the SQL starts with `?=CALL`
 *                        (function-return form).
 *   - `hasSelect`      : a SELECT token appears anywhere (used for
 *                        `INSERT ... SELECT` / subselect).
 *   - `hasForUpdate`   : a `FOR UPDATE` token pair appears.
 *   - `hasCurrentOf`   : a `WHERE CURRENT OF` token triple appears.
 *
 * Returns null for empty / whitespace / pure-comment SQL so
 * `isPackaged` can short-circuit.
 */
function tokenizeForPackage(text) {
  const len = text.length;
  if (len === 0) return null;

  // Strip a leading `?=` (JDBC function-return form) from the marker
  // count bookkeeping. JTOpen does the same in JDSQLStatement.
  let i = skipLeadingInsignificant(text, 0);
  if (i >= len) return null;

  let isReturnFunction = false;
  if (text.charCodeAt(i) === 0x3F /* ? */) {
    const after = skipLeadingInsignificant(text, i + 1);
    if (after < len && text.charCodeAt(after) === 0x3D /* = */) {
      // Peek past `?=` and make sure CALL follows (maybe with
      // whitespace). We don't advance `i` past `?=` yet — the full
      // walk below will re-read it but count the leading `?` as a
      // return-value marker, not a parameter. We set the flag and
      // then, during the walk, skip exactly that one `?`.
      const afterEq = skipLeadingInsignificant(text, after + 1);
      if (matchKeywordAt(text, afterEq, 'CALL')) {
        isReturnFunction = true;
      }
    }
  }

  let firstKeyword = null;
  let paramMarkers = 0;
  let hasSelect = false;
  let hasForUpdate = false;
  let hasCurrentOf = false;

  // Walk tokens. We buffer the active bareword and flush when we hit
  // a non-word char — much cheaper than regex and correct for
  // nested comments, quote escapes, and trailing semicolons.
  let token = '';
  let seenSignificantChar = false;
  let sawLeadingReturnMarker = false;

  // Simple state machine for multi-word phrase detection:
  //   forState    0 → looking for FOR; 1 → just saw FOR, next word
  //               decides.
  //   whereState  0 → idle; 1 → saw WHERE; 2 → saw WHERE CURRENT.
  let forState = 0;
  let whereState = 0;

  const flush = () => {
    if (!token) return;
    const up = token.toUpperCase();
    if (!firstKeyword) firstKeyword = up;
    if (up === 'SELECT') hasSelect = true;

    // FOR UPDATE — must be consecutive tokens.
    if (forState === 1) {
      if (up === 'UPDATE') hasForUpdate = true;
    }
    forState = up === 'FOR' ? 1 : 0;

    // WHERE CURRENT OF — must be consecutive tokens.
    if (whereState === 2) {
      if (up === 'OF') hasCurrentOf = true;
      whereState = 0;
    } else if (whereState === 1) {
      whereState = up === 'CURRENT' ? 2 : 0;
    }
    if (up === 'WHERE') whereState = 1;

    token = '';
  };

  i = 0;
  while (i < len) {
    const ch = text.charCodeAt(i);
    const next = i + 1 < len ? text.charCodeAt(i + 1) : 0;

    // Line comment `--` through newline.
    if (ch === 0x2D /* - */ && next === 0x2D) {
      flush();
      i += 2;
      while (i < len && text.charCodeAt(i) !== 0x0A /* \n */) i++;
      continue;
    }

    // Block comment `/* ... */`.
    if (ch === 0x2F /* / */ && next === 0x2A /* * */) {
      flush();
      i += 2;
      while (i + 1 < len && !(text.charCodeAt(i) === 0x2A && text.charCodeAt(i + 1) === 0x2F)) {
        i++;
      }
      i = Math.min(i + 2, len);
      continue;
    }

    // Single-quoted string literal with '' escape.
    if (ch === 0x27 /* ' */) {
      flush();
      i++;
      while (i < len) {
        if (text.charCodeAt(i) === 0x27) {
          if (i + 1 < len && text.charCodeAt(i + 1) === 0x27) {
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

    // Double-quoted identifier with "" escape.
    if (ch === 0x22 /* " */) {
      flush();
      i++;
      while (i < len) {
        if (text.charCodeAt(i) === 0x22) {
          if (i + 1 < len && text.charCodeAt(i + 1) === 0x22) {
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

    // Word char: a-z A-Z 0-9 _ $
    if ((ch >= 0x41 && ch <= 0x5A)   // A-Z
      || (ch >= 0x61 && ch <= 0x7A)  // a-z
      || (ch >= 0x30 && ch <= 0x39)  // 0-9
      || ch === 0x5F || ch === 0x24) {
      token += String.fromCharCode(ch);
      seenSignificantChar = true;
      i++;
      continue;
    }

    // Parameter marker (bare `?` outside comments/strings).
    if (ch === 0x3F /* ? */) {
      flush();
      // Skip the leading return-value marker exactly once so
      // `? = CALL FUNC(?, ?)` counts as 2 real parameters.
      if (isReturnFunction && !sawLeadingReturnMarker && !seenSignificantChar) {
        sawLeadingReturnMarker = true;
      } else {
        paramMarkers++;
      }
      seenSignificantChar = true;
      i++;
      continue;
    }

    // Any other significant char (operators, parens, etc.). We only
    // care that whitespace flushes tokens; `seenSignificantChar` is
    // set here so the `?=` prefix detector knows when we're past the
    // leading-return region.
    if (ch !== 0x20 /* space */ && ch !== 0x09 /* \t */
      && ch !== 0x0A && ch !== 0x0D) {
      seenSignificantChar = true;
    }
    flush();
    i++;
  }
  flush();

  if (!firstKeyword) return null;

  return {
    firstKeyword,
    paramMarkers,
    hasSelect,
    hasForUpdate,
    hasCurrentOf,
    isReturnFunction,
  };
}

function skipLeadingInsignificant(text, start) {
  const len = text.length;
  let i = start;
  while (i < len) {
    const ch = text.charCodeAt(i);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D) { i++; continue; }
    const next = i + 1 < len ? text.charCodeAt(i + 1) : 0;
    if (ch === 0x2D && next === 0x2D) {
      i += 2;
      while (i < len && text.charCodeAt(i) !== 0x0A) i++;
      continue;
    }
    if (ch === 0x2F && next === 0x2A) {
      i += 2;
      while (i + 1 < len && !(text.charCodeAt(i) === 0x2A && text.charCodeAt(i + 1) === 0x2F)) {
        i++;
      }
      i = Math.min(i + 2, len);
      continue;
    }
    break;
  }
  return i;
}

function matchKeywordAt(text, start, keyword) {
  const kl = keyword.length;
  if (start + kl > text.length) return false;
  for (let k = 0; k < kl; k++) {
    const ch = text.charCodeAt(start + k);
    const up = ch >= 0x61 && ch <= 0x7A ? ch - 32 : ch;
    if (up !== keyword.charCodeAt(k)) return false;
  }
  // boundary check: next char must not be a word char
  const after = start + kl;
  if (after < text.length) {
    const ch = text.charCodeAt(after);
    if ((ch >= 0x41 && ch <= 0x5A)
      || (ch >= 0x61 && ch <= 0x7A)
      || (ch >= 0x30 && ch <= 0x39)
      || ch === 0x5F || ch === 0x24) {
      return false;
    }
  }
  return true;
}
