/**
 * ResultSetMetaData — JDBC-parity metadata for query result columns.
 *
 * Wraps the column descriptors that come back from prepare/describe and
 * exposes the full JDBC ResultSetMetaData surface. The object is 1-based
 * to match JDBC: `getColumnCount()` returns N, and positional getters
 * expect 1..N.
 *
 * Upstream: AS400JDBCResultSetMetaData.java
 * @module db/api/ResultSetMetaData
 */

import { SqlType } from '../protocol/DBDescriptors.js';

/** JDBC java.sql.Types values for `getColumnType()`. */
export const JdbcType = Object.freeze({
  BIT:           -7,
  TINYINT:       -6,
  SMALLINT:      5,
  INTEGER:       4,
  BIGINT:        -5,
  FLOAT:         6,
  REAL:          7,
  DOUBLE:        8,
  NUMERIC:       2,
  DECIMAL:       3,
  CHAR:          1,
  VARCHAR:       12,
  LONGVARCHAR:   -1,
  DATE:          91,
  TIME:          92,
  TIMESTAMP:     93,
  BINARY:        -2,
  VARBINARY:     -3,
  LONGVARBINARY: -4,
  NULL:          0,
  OTHER:         1111,
  JAVA_OBJECT:   2000,
  DISTINCT:      2001,
  STRUCT:        2002,
  ARRAY:         2003,
  BLOB:          2004,
  CLOB:          2005,
  REF:           2006,
  DATALINK:      70,
  BOOLEAN:       16,
  ROWID:         -8,
  NCHAR:         -15,
  NVARCHAR:      -9,
  LONGNVARCHAR:  -16,
  NCLOB:         2011,
  SQLXML:        2009,
  DECFLOAT:      1111,
});

/** JDBC nullability constants. */
export const ColumnNullable = Object.freeze({
  noNulls:         0,
  nullable:        1,
  nullableUnknown: 2,
});

/** Map a host-server sqlType code to a java.sql.Types value. */
export function hostTypeToJdbc(sqlType) {
  const abs = Math.abs(sqlType) & 0xFFFE;
  switch (abs) {
    case 500: return JdbcType.SMALLINT;
    case 496: return JdbcType.INTEGER;
    case 492: return JdbcType.BIGINT;
    case 480: return JdbcType.DOUBLE;
    case 484: return JdbcType.DECIMAL;
    case 488: return JdbcType.NUMERIC;
    case 996: return JdbcType.DECFLOAT;
    case 452: return JdbcType.CHAR;
    case 448: return JdbcType.VARCHAR;
    case 456: return JdbcType.LONGVARCHAR;
    case 468: return JdbcType.CHAR;
    case 464: return JdbcType.VARCHAR;
    case 472: return JdbcType.LONGVARCHAR;
    case 384: return JdbcType.DATE;
    case 388: return JdbcType.TIME;
    case 392: return JdbcType.TIMESTAMP;
    case 912: return JdbcType.BINARY;
    case 908: return JdbcType.VARBINARY;
    case 404: return JdbcType.BLOB;
    case 408: return JdbcType.CLOB;
    case 412: return JdbcType.CLOB;
    case 960: return JdbcType.BLOB;
    case 964: return JdbcType.CLOB;
    case 968: return JdbcType.CLOB;
    case 904: return JdbcType.ROWID;
    case 396: return JdbcType.DATALINK;
    default:
      // Negative values used for extended types
      switch (sqlType) {
        case SqlType.BOOLEAN:      return JdbcType.BOOLEAN;
        case SqlType.XML:          return JdbcType.SQLXML;
        case SqlType.XML_LOCATOR:  return JdbcType.SQLXML;
        case SqlType.NCHAR:        return JdbcType.NCHAR;
        case SqlType.NVARCHAR:     return JdbcType.NVARCHAR;
        case SqlType.LONGNVARCHAR: return JdbcType.LONGNVARCHAR;
        case SqlType.NCLOB:        return JdbcType.NCLOB;
        case SqlType.NCLOB_LOCATOR:return JdbcType.NCLOB;
        case SqlType.ARRAY:        return JdbcType.ARRAY;
        case SqlType.ARRAY_LOCATOR:return JdbcType.ARRAY;
        default: return JdbcType.OTHER;
      }
  }
}

/** JS class name (for getColumnClassName) that best represents this type. */
export function hostTypeToClassName(sqlType) {
  const abs = Math.abs(sqlType) & 0xFFFE;
  switch (abs) {
    case 500:
    case 496: return 'java.lang.Integer';
    case 492: return 'java.lang.Long';
    case 480: return 'java.lang.Double';
    case 484:
    case 488:
    case 996: return 'java.math.BigDecimal';
    case 452:
    case 448:
    case 456:
    case 468:
    case 464:
    case 472: return 'java.lang.String';
    case 384: return 'java.sql.Date';
    case 388: return 'java.sql.Time';
    case 392: return 'java.sql.Timestamp';
    case 912:
    case 908: return '[B';
    case 404:
    case 960: return 'com.ibm.as400.access.AS400JDBCBlob';
    case 408:
    case 412:
    case 964:
    case 968: return 'com.ibm.as400.access.AS400JDBCClob';
    case 904: return 'com.ibm.as400.access.AS400JDBCRowId';
    case 396: return 'java.net.URL';
    default:
      switch (sqlType) {
        case SqlType.BOOLEAN:      return 'java.lang.Boolean';
        case SqlType.XML:
        case SqlType.XML_LOCATOR:  return 'com.ibm.as400.access.AS400JDBCSQLXML';
        case SqlType.NCHAR:
        case SqlType.NVARCHAR:
        case SqlType.LONGNVARCHAR: return 'java.lang.String';
        case SqlType.NCLOB:
        case SqlType.NCLOB_LOCATOR:return 'com.ibm.as400.access.AS400JDBCNClob';
        case SqlType.ARRAY:
        case SqlType.ARRAY_LOCATOR:return 'com.ibm.as400.access.AS400JDBCArray';
        default: return 'java.lang.Object';
      }
  }
}

/** Column display size — max characters for one value. */
function columnDisplaySize(desc) {
  const abs = Math.abs(desc.sqlType) & 0xFFFE;
  switch (abs) {
    case 500: return 6;   // -32768
    case 496: return 11;  // -2147483648
    case 492: return 20;  // -9223372036854775808
    case 480: return desc.length === 4 ? 15 : 24;
    case 484:
    case 488: return (desc.precision || desc.length || 0) + 2; // sign + dot
    case 996: return 43;  // DECFLOAT(34) max display
    case 452:
    case 448:
    case 456: return desc.length || 0;
    case 468:
    case 464:
    case 472: return Math.floor((desc.length || 0) / 2) || desc.length || 0;
    case 384: return desc.length || 10;
    case 388: return desc.length || 8;
    case 392: return desc.length || 26;
    case 912:
    case 908: return desc.length * 2; // hex representation
    case 404:
    case 960: return 2147483647;
    case 408:
    case 412:
    case 964:
    case 968: return 2147483647;
    case 904: return 40;
    default: return desc.length || 0;
  }
}

/**
 * JDBC ResultSetMetaData implementation.
 *
 * Column positions are 1-based to match the JDBC contract.
 */
export class ResultSetMetaData {
  #descriptors;

  /**
   * @param {object[]} descriptors - column descriptors from prepare/describe
   */
  constructor(descriptors) {
    this.#descriptors = Array.isArray(descriptors) ? descriptors : [];
  }

  /** @returns {number} column count */
  getColumnCount() {
    return this.#descriptors.length;
  }

  /** @returns {object[]} a copy of the underlying descriptor list */
  getDescriptors() {
    return this.#descriptors.slice();
  }

  // --- Per-column accessors ---

  isAutoIncrement(column) {
    return Boolean(this.#desc(column).autoIncrement);
  }

  isCaseSensitive(column) {
    const abs = Math.abs(this.#desc(column).sqlType) & 0xFFFE;
    // Character/LOB types are case-sensitive; numerics and dates are not.
    return abs === 452 || abs === 448 || abs === 456
        || abs === 468 || abs === 464 || abs === 472
        || abs === 404 || abs === 408 || abs === 412
        || abs === 960 || abs === 964 || abs === 968
        || abs === 904 || abs === 396;
  }

  isSearchable(column) {
    // LONGVARCHAR, LONGVARBINARY, LOB types are not searchable in WHERE clauses.
    const abs = Math.abs(this.#desc(column).sqlType) & 0xFFFE;
    return abs !== 456 && abs !== 472
        && abs !== 404 && abs !== 408 && abs !== 412
        && abs !== 960 && abs !== 964 && abs !== 968;
  }

  isCurrency(_column) {
    return false;
  }

  isNullable(column) {
    return this.#desc(column).nullable
      ? ColumnNullable.nullable
      : ColumnNullable.noNulls;
  }

  isSigned(column) {
    const abs = Math.abs(this.#desc(column).sqlType) & 0xFFFE;
    return abs === 500 || abs === 496 || abs === 492
        || abs === 480 || abs === 484 || abs === 488
        || abs === 996;
  }

  getColumnDisplaySize(column) {
    return columnDisplaySize(this.#desc(column));
  }

  getColumnLabel(column) {
    const d = this.#desc(column);
    return d.label || d.name || `COL${d.index ?? column - 1}`;
  }

  getColumnName(column) {
    const d = this.#desc(column);
    return d.name || d.label || `COL${d.index ?? column - 1}`;
  }

  getSchemaName(column) {
    return this.#desc(column).schemaName || '';
  }

  getPrecision(column) {
    const d = this.#desc(column);
    return d.precision ?? d.length ?? 0;
  }

  getScale(column) {
    return this.#desc(column).scale ?? 0;
  }

  getTableName(column) {
    return this.#desc(column).tableName || '';
  }

  getCatalogName(_column) {
    return '';
  }

  getColumnType(column) {
    return hostTypeToJdbc(this.#desc(column).sqlType);
  }

  getColumnTypeName(column) {
    return this.#desc(column).typeName || '';
  }

  getHostSqlType(column) {
    return this.#desc(column).sqlType;
  }

  getCCSID(column) {
    return this.#desc(column).ccsid ?? 0;
  }

  isReadOnly(column) {
    return Boolean(this.#desc(column).readOnly);
  }

  isWritable(column) {
    return !this.isReadOnly(column);
  }

  isDefinitelyWritable(column) {
    return false;
  }

  getColumnClassName(column) {
    return hostTypeToClassName(this.#desc(column).sqlType);
  }

  /** Plain-object projection for legacy callers. */
  toPlainArray() {
    return this.#descriptors.map((d, i) => ({
      index:       i + 1,
      name:        d.name || d.label || `COL${i}`,
      label:       d.label || d.name || '',
      typeName:    d.typeName,
      sqlType:     d.sqlType,
      jdbcType:    hostTypeToJdbc(d.sqlType),
      className:   hostTypeToClassName(d.sqlType),
      precision:   d.precision ?? 0,
      scale:       d.scale ?? 0,
      ccsid:       d.ccsid ?? 0,
      nullable:    Boolean(d.nullable),
      tableName:   d.tableName || '',
      schemaName:  d.schemaName || '',
      displaySize: columnDisplaySize(d),
    }));
  }

  /** Retrieve a descriptor by 1-based column position. */
  #desc(column) {
    const idx = Number(column) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.#descriptors.length) {
      throw new RangeError(
        `Column index out of range: ${column} (expected 1..${this.#descriptors.length})`,
      );
    }
    return this.#descriptors[idx];
  }
}
