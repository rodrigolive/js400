/**
 * Database metadata queries and capability reporting.
 *
 * Provides schema discovery through SQL catalog queries against
 * QSYS2 system views (SYSTABLES, SYSCOLUMNS, SYSINDEXES, etc.).
 * Also exposes the full JDBC DatabaseMetaData capability-reporting
 * surface (supports*, getMax*, getSQLKeywords, etc.) matching
 * JTOpen's AS400JDBCDatabaseMetaData.
 *
 * Upstream: AS400JDBCDatabaseMetaData.java
 * @module db/api/DatabaseMetaData
 */

import { JdbcType } from './ResultSetMetaData.js';

// ─── Table-type constants (JTOpen: JDTableTypeFieldMap) ─────────────

const TABLE_TYPE_ALIASES = Object.freeze({
  ALIAS: ['A', 'ALIAS', 'SYNONYM'],
  SYNONYM: ['A', 'ALIAS', 'SYNONYM'],
  TABLE: ['T', 'TABLE'],
  VIEW: ['V', 'VIEW'],
  'SYSTEM TABLE': ['S', 'SYSTEM TABLE'],
  'MATERIALIZED QUERY TABLE': ['M', 'MQT', 'MATERIALIZED QUERY TABLE'],
  MQT: ['M', 'MQT', 'MATERIALIZED QUERY TABLE'],
});

const TABLE_TYPE_LABELS = Object.freeze({
  A: 'ALIAS',
  ALIAS: 'ALIAS',
  SYNONYM: 'ALIAS',
  T: 'TABLE',
  TABLE: 'TABLE',
  V: 'VIEW',
  VIEW: 'VIEW',
  S: 'SYSTEM TABLE',
  'SYSTEM TABLE': 'SYSTEM TABLE',
  M: 'MATERIALIZED QUERY TABLE',
  MQT: 'MATERIALIZED QUERY TABLE',
  'MATERIALIZED QUERY TABLE': 'MATERIALIZED QUERY TABLE',
});

const NUMERIC_TYPES = new Set([
  'BIGINT', 'DECIMAL', 'DECFLOAT', 'DOUBLE', 'FLOAT',
  'INTEGER', 'NUMERIC', 'REAL', 'SMALLINT',
]);

const CHARACTER_TYPES = new Set([
  'CHAR', 'CHARACTER', 'VARCHAR', 'CHARACTER VARYING',
  'LONG VARCHAR', 'CLOB',
]);

const GRAPHIC_TYPES = new Set([
  'GRAPHIC', 'VARGRAPHIC', 'LONG VARGRAPHIC', 'DBCLOB',
]);

const BINARY_TYPES = new Set(['BINARY', 'VARBINARY', 'BLOB']);

const DATETIME_COLUMN_SIZES = Object.freeze({
  DATE: 10,
  TIME: 8,
  TIMESTAMP: 26,
});

// ─── JDBC bestRow / versionColumn pseudo-column constants ────────────

export const BestRowScope = Object.freeze({
  temporary:  0,
  transaction: 1,
  session:    2,
});

export const BestRowNullable = Object.freeze({
  unknown:  0,
  noNulls:  1,
  nullable: 2,
});

export const VersionColumnPseudo = Object.freeze({
  notPseudo:     0,
  isPseudo:      1,
  pseudoUnknown: 2,
});

// ─── Foreign-key rule constants ──────────────────────────────────────

export const ForeignKeyRule = Object.freeze({
  noAction:  0,  // SQL NO ACTION
  restrict:  1,
  cascade:   2,
  setNull:   3,
  setDefault: 4,
  initiallyDeferred:  5,
  initiallyImmediate: 6,
  notDeferrable:      7,
});

// ─── JDBC typeNullable / typeSearchable ──────────────────────────────

const TYPE_NULLABLE = 1;   // typeNullable
const TYPE_SEARCHABLE = 3; // typeSearchable

// ─── Internal helpers ────────────────────────────────────────────────

function normalizePattern(value) {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

function pushLike(conditions, params, field, value) {
  if (!value) return;
  conditions.push(`${field} LIKE ?`);
  params.push(normalizePattern(value));
}

function pushEq(conditions, params, field, value) {
  if (value == null) return;
  conditions.push(`${field} = ?`);
  params.push(String(value).toUpperCase());
}

function toNumber(value) {
  return value == null ? null : Number(value);
}

function normalizeNullable(value) {
  const n = String(value ?? '').trim().toUpperCase();
  return n === 'NO' || n === 'N' || n === '0' ? 'NO' : 'YES';
}

function normalizeTableType(value) {
  return TABLE_TYPE_LABELS[String(value ?? '').trim().toUpperCase()]
    ?? String(value ?? '').trim().toUpperCase();
}

function getRequestedTableTypes(type) {
  if (!type) return [];
  const types = Array.isArray(type) ? type : [type];
  const expanded = [];
  for (const item of types) {
    const key = String(item).trim().toUpperCase();
    const aliases = TABLE_TYPE_ALIASES[key] ?? [key];
    for (const alias of aliases) {
      if (!expanded.includes(alias)) expanded.push(alias);
    }
  }
  return expanded;
}

function getColumnSize(row) {
  const typeName = String(row.DATA_TYPE ?? '').trim().toUpperCase();
  const length = toNumber(row.LENGTH);
  const precision = toNumber(row.NUMERIC_PRECISION);
  if (NUMERIC_TYPES.has(typeName)) return precision ?? length;
  if (typeName in DATETIME_COLUMN_SIZES) return length ?? DATETIME_COLUMN_SIZES[typeName];
  return length;
}

function getDecimalDigits(row) {
  const typeName = String(row.DATA_TYPE ?? '').trim().toUpperCase();
  if (!NUMERIC_TYPES.has(typeName)) return null;
  return toNumber(row.NUMERIC_SCALE) ?? 0;
}

function getCharOctetLength(row) {
  const typeName = String(row.DATA_TYPE ?? '').trim().toUpperCase();
  const length = toNumber(row.LENGTH);
  if (length == null) return null;
  if (GRAPHIC_TYPES.has(typeName)) return length * 2;
  if (CHARACTER_TYPES.has(typeName) || BINARY_TYPES.has(typeName)) return length;
  return null;
}

// ─── Row mappers (project QSYS2 catalog rows to JDBC shape) ──────────

function mapSchemaRow(row) {
  return { ...row, TABLE_CATALOG: null, TABLE_SCHEM: row.SCHEMA_NAME };
}

function mapTableRow(row) {
  return {
    ...row,
    TABLE_CAT: null,
    TABLE_SCHEM: row.TABLE_SCHEMA,
    TABLE_TYPE: normalizeTableType(row.TABLE_TYPE),
    REMARKS: row.TABLE_TEXT ?? '',
    SYSTEM_TABLE_TYPE: row.TABLE_TYPE,
  };
}

function mapColumnRow(row) {
  const nullableText = normalizeNullable(row.IS_NULLABLE);
  const typeName = String(row.DATA_TYPE ?? '').trim().toUpperCase();
  return {
    ...row,
    TABLE_CAT: null,
    TABLE_SCHEM: row.TABLE_SCHEMA,
    TYPE_NAME: typeName,
    COLUMN_SIZE: getColumnSize(row),
    BUFFER_LENGTH: null,
    DECIMAL_DIGITS: getDecimalDigits(row),
    NUM_PREC_RADIX: NUMERIC_TYPES.has(typeName) ? 10 : null,
    NULLABLE: nullableText === 'NO' ? 0 : 1,
    REMARKS: row.COLUMN_TEXT ?? '',
    COLUMN_DEF: row.COLUMN_DEFAULT,
    SQL_DATA_TYPE: null,
    SQL_DATETIME_SUB: null,
    CHAR_OCTET_LENGTH: getCharOctetLength(row),
    IS_NULLABLE: nullableText,
  };
}

function mapExportedKeyRow(row) {
  return {
    PKTABLE_CAT: null,
    PKTABLE_SCHEM: row.PKTABLE_SCHEM ?? row.PKTABLE_SCHEMA ?? '',
    PKTABLE_NAME: row.PKTABLE_NAME ?? '',
    PKCOLUMN_NAME: row.PKCOLUMN_NAME ?? '',
    FKTABLE_CAT: null,
    FKTABLE_SCHEM: row.FKTABLE_SCHEM ?? row.FKTABLE_SCHEMA ?? '',
    FKTABLE_NAME: row.FKTABLE_NAME ?? '',
    FKCOLUMN_NAME: row.FKCOLUMN_NAME ?? '',
    KEY_SEQ: toNumber(row.KEY_SEQ) ?? 0,
    UPDATE_RULE: mapRule(row.UPDATE_RULE),
    DELETE_RULE: mapRule(row.DELETE_RULE),
    FK_NAME: row.FK_NAME ?? '',
    PK_NAME: row.PK_NAME ?? '',
    DEFERRABILITY: ForeignKeyRule.notDeferrable,
  };
}

function mapRule(v) {
  const s = String(v ?? '').trim().toUpperCase();
  switch (s) {
    case 'C': case 'CASCADE':           return ForeignKeyRule.cascade;
    case 'R': case 'RESTRICT':          return ForeignKeyRule.restrict;
    case 'N': case 'SET NULL':           return ForeignKeyRule.setNull;
    case 'D': case 'SET DEFAULT':       return ForeignKeyRule.setDefault;
    default:                            return ForeignKeyRule.noAction;
  }
}

function mapFunctionRow(row) {
  return {
    FUNCTION_CAT: null,
    FUNCTION_SCHEM: row.SPECIFIC_SCHEMA ?? row.ROUTINE_SCHEMA ?? '',
    FUNCTION_NAME: row.ROUTINE_NAME ?? '',
    REMARKS: row.ROUTINE_TEXT ?? row.REMARKS ?? '',
    SPECIFIC_NAME: row.SPECIFIC_NAME ?? '',
  };
}

function mapFunctionColumnRow(row) {
  return {
    FUNCTION_CAT: null,
    FUNCTION_SCHEM: row.SPECIFIC_SCHEMA ?? '',
    FUNCTION_NAME: row.ROUTINE_NAME ?? row.SPECIFIC_NAME ?? '',
    COLUMN_NAME: row.PARAMETER_NAME ?? '',
    COLUMN_TYPE: toNumber(row.COLUMN_TYPE) ?? 0,
    DATA_TYPE: toNumber(row.DATA_TYPE_JDBC) ?? JdbcType.OTHER,
    TYPE_NAME: row.DATA_TYPE ?? '',
    PRECISION: toNumber(row.NUMERIC_PRECISION) ?? toNumber(row.LENGTH) ?? 0,
    LENGTH: toNumber(row.LENGTH) ?? 0,
    SCALE: toNumber(row.NUMERIC_SCALE) ?? 0,
    RADIX: 10,
    NULLABLE: toNumber(row.IS_NULLABLE) === 0 ? 0 : 1,
    REMARKS: row.REMARKS ?? '',
    CHAR_OCTET_LENGTH: null,
    ORDINAL_POSITION: toNumber(row.ORDINAL_POSITION) ?? 0,
    IS_NULLABLE: normalizeNullable(row.IS_NULLABLE),
    SPECIFIC_NAME: row.SPECIFIC_NAME ?? '',
  };
}

// ─── Type-info table (mirrors JTOpen getTypeInfo) ────────────────────

const TYPE_INFO_ROWS = [
  { TYPE_NAME: 'CHAR',            DATA_TYPE: JdbcType.CHAR,          PRECISION: 32765, LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: 'length',      CASE_SENSITIVE: true,  UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'VARCHAR',         DATA_TYPE: JdbcType.VARCHAR,       PRECISION: 32739, LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: 'length',      CASE_SENSITIVE: true,  UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'LONG VARCHAR',    DATA_TYPE: JdbcType.LONGVARCHAR,   PRECISION: 32739, LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: null,           CASE_SENSITIVE: true,  UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'GRAPHIC',         DATA_TYPE: JdbcType.CHAR,          PRECISION: 16382, LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: 'length',      CASE_SENSITIVE: true,  UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'VARGRAPHIC',      DATA_TYPE: JdbcType.VARCHAR,       PRECISION: 16369, LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: 'length',      CASE_SENSITIVE: true,  UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'LONG VARGRAPHIC', DATA_TYPE: JdbcType.LONGVARCHAR,   PRECISION: 16369, LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: null,           CASE_SENSITIVE: true,  UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'BINARY',          DATA_TYPE: JdbcType.BINARY,        PRECISION: 32765, LITERAL_PREFIX: "X'", LITERAL_SUFFIX: "'", CREATE_PARAMS: 'length',      CASE_SENSITIVE: false, UNSIGNED: true,  MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'VARBINARY',       DATA_TYPE: JdbcType.VARBINARY,     PRECISION: 32739, LITERAL_PREFIX: "X'", LITERAL_SUFFIX: "'", CREATE_PARAMS: 'length',      CASE_SENSITIVE: false, UNSIGNED: true,  MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'DATE',            DATA_TYPE: JdbcType.DATE,          PRECISION: 10,    LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'TIME',            DATA_TYPE: JdbcType.TIME,          PRECISION: 8,     LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'TIMESTAMP',       DATA_TYPE: JdbcType.TIMESTAMP,     PRECISION: 26,    LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 12, RADIX: null },
  { TYPE_NAME: 'DECIMAL',         DATA_TYPE: JdbcType.DECIMAL,       PRECISION: 63,    LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: 'precision,scale', CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 63, RADIX: 10 },
  { TYPE_NAME: 'NUMERIC',         DATA_TYPE: JdbcType.NUMERIC,       PRECISION: 63,    LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: 'precision,scale', CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 63, RADIX: 10 },
  { TYPE_NAME: 'DECFLOAT',        DATA_TYPE: JdbcType.OTHER,        PRECISION: 34,    LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: 'precision',     CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: 10 },
  { TYPE_NAME: 'SMALLINT',        DATA_TYPE: JdbcType.SMALLINT,      PRECISION: 5,     LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: 10 },
  { TYPE_NAME: 'INTEGER',         DATA_TYPE: JdbcType.INTEGER,      PRECISION: 10,    LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: 10 },
  { TYPE_NAME: 'BIGINT',          DATA_TYPE: JdbcType.BIGINT,       PRECISION: 19,    LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: 10 },
  { TYPE_NAME: 'REAL',            DATA_TYPE: JdbcType.REAL,          PRECISION: 24,    LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: 2 },
  { TYPE_NAME: 'FLOAT',           DATA_TYPE: JdbcType.DOUBLE,        PRECISION: 53,    LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: 2 },
  { TYPE_NAME: 'DOUBLE',          DATA_TYPE: JdbcType.DOUBLE,        PRECISION: 53,    LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: 2 },
  { TYPE_NAME: 'BLOB',            DATA_TYPE: JdbcType.BLOB,         PRECISION: 2147483647, LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: 'length',  CASE_SENSITIVE: false, UNSIGNED: true,  MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'CLOB',            DATA_TYPE: JdbcType.CLOB,         PRECISION: 2147483647, LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: 'length',  CASE_SENSITIVE: true,  UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'DBCLOB',          DATA_TYPE: JdbcType.CLOB,         PRECISION: 1073741822, LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: 'length', CASE_SENSITIVE: true,  UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'DATALINK',        DATA_TYPE: JdbcType.DATALINK,     PRECISION: 32717, LITERAL_PREFIX: "'", LITERAL_SUFFIX: "'", CREATE_PARAMS: 'length',      CASE_SENSITIVE: true,  UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'ROWID',           DATA_TYPE: JdbcType.ROWID,        PRECISION: 40,    LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: true,  MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'XML',             DATA_TYPE: JdbcType.SQLXML,       PRECISION: 2147483647, LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: null,    CASE_SENSITIVE: true,  UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
  { TYPE_NAME: 'BOOLEAN',         DATA_TYPE: JdbcType.BOOLEAN,      PRECISION: 1,     LITERAL_PREFIX: null, LITERAL_SUFFIX: null, CREATE_PARAMS: null,           CASE_SENSITIVE: false, UNSIGNED: false, MIN_SCALE: 0, MAX_SCALE: 0,  RADIX: null },
];

// ─── SQL functions lists (mirrors JTOpen JDEscapeClause) ────────────

const NUMERIC_FUNCTIONS = [
  'ABS', 'ACOS', 'ASIN', 'ATAN', 'ATAN2', 'CEILING', 'COS',
  'COT', 'DEGREES', 'EXP', 'FLOOR', 'LOG', 'LOG10', 'MOD',
  'PI', 'POWER', 'RADIANS', 'RAND', 'ROUND', 'SIGN', 'SIN',
  'SQRT', 'TAN', 'TRUNCATE',
];

const STRING_FUNCTIONS = [
  'ASCII', 'CHAR', 'CHAR_LENGTH', 'CHARACTER_LENGTH', 'CONCAT',
  'DIFFERENCE', 'INSERT', 'LCASE', 'LEFT', 'LENGTH', 'LOCATE',
  'LTRIM', 'OCTET_LENGTH', 'POSITION', 'REPEAT', 'REPLACE',
  'RIGHT', 'RTRIM', 'SOUNDEX', 'SPACE', 'SUBSTRING', 'UCASE',
];

const SYSTEM_FUNCTIONS = [
  'DATABASE', 'IFNULL', 'USER',
];

const TIME_DATE_FUNCTIONS = [
  'CURDATE', 'CURTIME', 'DAYNAME', 'DAYOFMONTH', 'DAYOFWEEK',
  'DAYOFYEAR', 'HOUR', 'MINUTE', 'MONTH', 'MONTHNAME', 'NOW',
  'QUARTER', 'SECOND', 'TIMESTAMPADD', 'TIMESTAMPDIFF', 'WEEK',
  'YEAR',
];

// ─── SQL keywords (IBM i reserved words) ─────────────────────────────

const SQL_KEYWORDS = [
  'ALL','ALLOCATE','ALLOW','ALTER','AND','ANY','AS','ASENSITIVE',
  'ASSOCIATE','ASUTIME','AT','AUDIT','AUX','AVERAGE','BEGIN',
  'BETWEEN','BINARY','BIT','BUFFERPOOL','BY','CACHE','CALL',
  'CALLED','CAPTURE','CASCADED','CASE','CAST','CCSID','CHAR',
  'CHECK','CLONE','CLOSE','CLUSTER','COLLECT','COLLATE','COLUMN',
  'COMMIT','CONCAT','CONCURRENT','CONDITION','CONNECT','CONNECTION',
  'CONSTRAINT','CONTAINS','CONTINUE','COPY','COUNT','COUNT_BIG',
  'CREATE','CROSS','CURRENT','CURRENT_DATE','CURRENT_PATH',
  'CURRENT_TIME','CURRENT_TIMESTAMP','CURRENT_TIMEZONE','CURSOR',
  'CYCLE','DATA','DATABASE','DATAPARTITIONNUM','DB2SQLSTATE',
  'DBINFO','DEALLOCATE','DECLARE','DEFAULT','DEFAULTS','DEFER',
  'DEFINE','DEFINITION','DELETE','DENSERANK','DESCRIBE',
  'DESCRIPTOR','DETERMINISTIC','DISABLE','DISALLOW','DISCONNECT',
  'DISTINCT','DO','DOUBLE','DROP','DSSIZE','DYNAMIC','EACH',
  'EDITPROC','ELSE','ELSEIF','ENABLE','ENCRYPTION','END','ENDING',
  'ERASE','ESCAPE','EXCEPT','EXCEPTION','EXCLUDING','EXECUTE',
  'EXISTS','EXIT','EXPLAIN','EXTERNAL','FENCED','FETCH',
  'FIELDPROC','FINAL','FOR','FOREIGN','FREE','FROM','FULL',
  'FUNCTION','GENERAL','GENERATED','GET','GLOBAL','GO','GOTO',
  'GRANT','GRAPHIC','GROUP','HANDLER','HASH','HASHED_VALUE',
  'HAVING','HINT','HOLD','HOUR','IF','IMMEDIATE','IN','INCLUDING',
  'INCLUSIVE','INDEX','INDICATOR','INHERIT','INNER','INOUT',
  'INSENSITIVE','INSERT','INTEGRITY','INTERSECT','INTO','IS',
  'ISOBID','ISOLATION','ITERATE','JAR','JOIN','KEEP','KEY',
  'LABEL','LANGUAGE','LATERAL','LCASE','LEAVE','LEFT','LIKE',
  'LINKTYPE','LOCAL','LOCALE','LOCATOR','LOCATORS','LOCK',
  'LOCKMAX','LOCKSIZE','LONG','LOOP','MAXVALUE','MICROSECOND',
  'MINUTEMINUTE','MINVALUE','MODE','MODIFIES','MONTH','MONTHS',
  'NEW','NEW_TABLE','NEXTVAL','NO','NOCACHE','NOCYCLE','NOMAXVALUE',
  'NOMINVALUE','NONE','NOORDER','NOT','NULL','NULLS','NUMPARTS',
  'OBID','OF','OLD','OLD_TABLE','ON','OPEN','OPTIMIZATION',
  'OPTIMIZE','OPTION','OR','ORDER','ORDINALITY','OUT','OUTER',
  'OVERRIDING','PACKAGE','PAD','PARAMETER','PART','PARTITION',
  'PATH','PIECESIZE','POSITION','PRECISION','PREPARE','PREVVAL',
  'PRIMARY','PRIQTY','PRIVILEGES','PROCEDURE','PROGRAM','PSID',
  'PUBLIC','QUERY','QUERYNO','READS','REFERENCES','REFERENCING',
  'RELEASE','RENAME','REPEAT','RESET','RESIGNAL','RESTART',
  'RESULT','RETURN','RETURNS','REVOKE','RIGHT','ROLLBACK','ROUND_CEILING',
  'ROUND_DOWN','ROUND_FLOOR','ROUND_HALF_DOWN','ROUND_HALF_EVEN',
  'ROUND_HALF_UP','ROUND_UP','ROUTINE','ROW','ROWNUMBER','ROWS',
  'ROWSET','RRN','RUN','SAVEPOINT','SCHEMA','SCRATCHPAD','SCROLL',
  'SECOND','SECQTY','SECURITY','SELECT','SENSITIVE','SEQUENCE',
  'SESSION','SET','SIGNAL','SIMPLE','SOME','SOURCE','SPECIFIC',
  'SQL','SQLEXCEPTION','SQLSTATE','SQLWARNING','STATIC','STATISTICS',
  'STOGROUP','STORES','STYLE','SUBSTRING','SUMMARY','SYNONYM',
  'SYSTEM','TABLE','TABLESPACE','THEN','THREADSAFE','TO','TRAILING',
  'TRANSACTION','TRIGGER','TRIM','TYPE','UNDO','UNION','UNIQUE',
  'UNTIL','UPDATE','USAGE','USER','USING','VALIDPROC','VALUE',
  'VALUES','VARIABLE','VARIANT','VCAT','VERSION','VIEW','VOLATILE',
  'WHEN','WHENEVER','WHERE','WHILE','WITH','WLM','WRITE','XMLELEMENT',
  'XMLEXISTS','XMLFOREST','XMLNAMESPACES','XMLPARSE','XMLPI',
  'XMLQUERY','XMLSERIALIZE','YEAR','YEARS',
];

// ─── DatabaseMetaData class ──────────────────────────────────────────

export class DatabaseMetaData {
  #connection;

  /**
   * @param {object} connection - a Connection instance with query() method
   */
  constructor(connection) {
    this.#connection = connection;
  }

  // ─── Catalog discovery ───────────────────────────────────────────

  /**
   * List schemas (libraries).
   * @param {object} [opts]
   * @param {string} [opts.schema] - filter pattern (SQL LIKE)
   * @returns {Promise<object[]>}
   */
  async getSchemas(opts = {}) {
    let sql = `SELECT SCHEMA_NAME, SCHEMA_OWNER, SYSTEM_SCHEMA_NAME
               FROM QSYS2.SYSSCHEMAS`;
    const params = [];
    if (opts.schema) {
      sql += ` WHERE SCHEMA_NAME LIKE ?`;
      params.push(normalizePattern(opts.schema));
    }
    sql += ` ORDER BY SCHEMA_NAME`;
    const rows = await this.#connection.query(sql, params);
    return rows.map(mapSchemaRow);
  }

  /**
   * List catalogs. On IBM i this returns the system name.
   * @returns {Promise<object[]>}
   */
  async getCatalogs() {
    return [{ TABLE_CAT: null }];
  }

  /**
   * List supported table types.
   * @returns {object[]}
   */
  getTableTypes() {
    return [
      { TABLE_TYPE: 'TABLE' },
      { TABLE_TYPE: 'VIEW' },
      { TABLE_TYPE: 'SYSTEM TABLE' },
      { TABLE_TYPE: 'ALIAS' },
      { TABLE_TYPE: 'MATERIALIZED QUERY TABLE' },
    ];
  }

  /**
   * List all supported SQL types (mirrors JTOpen getTypeInfo).
   * @returns {object[]}
   */
  getTypeInfo() {
    return TYPE_INFO_ROWS.map(t => ({
      TYPE_NAME:          t.TYPE_NAME,
      DATA_TYPE:          t.DATA_TYPE,
      PRECISION:          t.PRECISION,
      LITERAL_PREFIX:     t.LITERAL_PREFIX,
      LITERAL_SUFFIX:     t.LITERAL_SUFFIX,
      CREATE_PARAMS:      t.CREATE_PARAMS,
      NULLABLE:           TYPE_NULLABLE,
      CASE_SENSITIVE:     t.CASE_SENSITIVE ? 1 : 0,
      SEARCHABLE:         TYPE_SEARCHABLE,
      UNSIGNED_ATTRIBUTE: t.UNSIGNED ? 1 : 0,
      FIXED_PREC_SCALE:   0,
      AUTO_INCREMENT:     0,
      LOCAL_TYPE_NAME:    null,
      MINIMUM_SCALE:      t.MIN_SCALE,
      MAXIMUM_SCALE:      t.MAX_SCALE,
      SQL_DATA_TYPE:      null,
      SQL_DATETIME_SUB:   null,
      NUM_PREC_RADIX:     t.RADIX,
    }));
  }

  // ─── Table / column discovery ─────────────────────────────────────

  /**
   * List tables.
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.table]
   * @param {string} [opts.type]
   * @returns {Promise<object[]>}
   */
  async getTables(opts = {}) {
    let sql = `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_TEXT
               FROM QSYS2.SYSTABLES`;
    const conditions = [];
    const params = [];
    pushLike(conditions, params, 'TABLE_SCHEMA', opts.schema);
    pushLike(conditions, params, 'TABLE_NAME', opts.table);
    const tableTypes = getRequestedTableTypes(opts.type);
    if (tableTypes.length > 0) {
      conditions.push(`TABLE_TYPE IN (${tableTypes.map(() => '?').join(', ')})`);
      params.push(...tableTypes);
    }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY TABLE_SCHEMA, TABLE_NAME`;
    const rows = await this.#connection.query(sql, params);
    return rows.map(mapTableRow);
  }

  /**
   * List columns for a table.
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.table]
   * @param {string} [opts.column]
   * @returns {Promise<object[]>}
   */
  async getColumns(opts = {}) {
    let sql = `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION,
                      DATA_TYPE, LENGTH, NUMERIC_SCALE, NUMERIC_PRECISION,
                      IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TEXT, CCSID
               FROM QSYS2.SYSCOLUMNS`;
    const conditions = [];
    const params = [];
    pushLike(conditions, params, 'TABLE_SCHEMA', opts.schema);
    pushLike(conditions, params, 'TABLE_NAME', opts.table);
    pushLike(conditions, params, 'COLUMN_NAME', opts.column);
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;
    const rows = await this.#connection.query(sql, params);
    return rows.map(mapColumnRow);
  }

  /**
   * List column privileges.
   * @param {object} opts
   * @param {string} opts.schema
   * @param {string} opts.table
   * @param {string} [opts.column]
   * @returns {Promise<object[]>}
   */
  async getColumnPrivileges(opts = {}) {
    let sql = `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, GRANTOR, GRANTEE,
                      PRIVILEGE_TYPE, IS_GRANTABLE
               FROM QSYS2.SYSCOLAUTH`;
    const conditions = [];
    const params = [];
    pushEq(conditions, params, 'TABLE_SCHEMA', opts.schema);
    pushEq(conditions, params, 'TABLE_NAME', opts.table);
    pushLike(conditions, params, 'COLUMN_NAME', opts.column);
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY COLUMN_NAME, PRIVILEGE_TYPE`;
    return this.#connection.query(sql, params);
  }

  /**
   * List table privileges.
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.table]
   * @returns {Promise<object[]>}
   */
  async getTablePrivileges(opts = {}) {
    let sql = `SELECT TABLE_SCHEMA, TABLE_NAME, GRANTOR, GRANTEE,
                      PRIVILEGE_TYPE, IS_GRANTABLE
               FROM QSYS2.SYSTABAUTH`;
    const conditions = [];
    const params = [];
    pushLike(conditions, params, 'TABLE_SCHEMA', opts.schema);
    pushLike(conditions, params, 'TABLE_NAME', opts.table);
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY TABLE_SCHEMA, TABLE_NAME, PRIVILEGE_TYPE`;
    return this.#connection.query(sql, params);
  }

  // ─── Primary key / index / best-row ───────────────────────────────

  /**
   * List primary keys for a table.
   * @param {object} opts
   * @param {string} opts.schema
   * @param {string} opts.table
   * @returns {Promise<object[]>}
   */
  async getPrimaryKeys(opts = {}) {
    let sql = `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION
               FROM QSYS2.SYSKEYCST
               WHERE CONSTRAINT_TYPE = 'PRIMARY KEY'`;
    const params = [];
    if (opts.schema) { sql += ` AND TABLE_SCHEMA = ?`; params.push(opts.schema.toUpperCase()); }
    if (opts.table)  { sql += ` AND TABLE_NAME = ?`;  params.push(opts.table.toUpperCase()); }
    sql += ` ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;
    return this.#connection.query(sql, params);
  }

  /**
   * List indexes for a table.
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.table]
   * @returns {Promise<object[]>}
   */
  async getIndexes(opts = {}) {
    let sql = `SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, INDEX_SCHEMA,
                      IS_UNIQUE, COLUMN_NAME, ORDINAL_POSITION, ORDERING
               FROM QSYS2.SYSINDEXES I
               JOIN QSYS2.SYSKEYS K
                 ON I.INDEX_NAME = K.INDEX_NAME AND I.INDEX_SCHEMA = K.INDEX_SCHEMA`;
    const conditions = [];
    const params = [];
    if (opts.schema) { conditions.push(`I.TABLE_SCHEMA = ?`); params.push(opts.schema.toUpperCase()); }
    if (opts.table)  { conditions.push(`I.TABLE_NAME = ?`);  params.push(opts.table.toUpperCase()); }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY I.TABLE_SCHEMA, I.TABLE_NAME, I.INDEX_NAME, K.ORDINAL_POSITION`;
    return this.#connection.query(sql, params);
  }

  /**
   * Describe the columns that best identify a row (primary key or
   * unique index). Uses QSYS2.SYSKEYCST for PRIMARY KEY constraint
   * columns.
   *
   * @param {object} opts
   * @param {string} opts.schema
   * @param {string} opts.table
   * @param {number} [opts.scope=BestRowScope.temporary]
   * @param {boolean} [opts.nullable=false]
   * @returns {Promise<object[]>}
   */
  async getBestRowIdentifier(opts = {}) {
    const scope = opts.scope ?? BestRowScope.temporary;
    const sql = `SELECT COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE
                 FROM QSYS2.SYSKEYCST C
                 JOIN QSYS2.SYSCOLUMNS COL
                   ON C.TABLE_SCHEMA = COL.TABLE_SCHEMA
                  AND C.TABLE_NAME   = COL.TABLE_NAME
                  AND C.COLUMN_NAME  = COL.COLUMN_NAME
                 WHERE C.CONSTRAINT_TYPE = 'PRIMARY KEY'
                   AND C.TABLE_SCHEMA = ?
                   AND C.TABLE_NAME  = ?`;
    const params = [String(opts.schema || '').toUpperCase(), String(opts.table || '').toUpperCase()];
    const rows = await this.#connection.query(sql, params);
    return rows.map(r => ({
      SCOPE:          scope,
      COLUMN_NAME:    r.COLUMN_NAME,
      DATA_TYPE:      JdbcType.OTHER,
      TYPE_NAME:      String(r.DATA_TYPE ?? '').trim().toUpperCase(),
      COLUMN_SIZE:    toNumber(r.LENGTH) ?? 0,
      BUFFER_LENGTH:  0,
      DECIMAL_DIGITS: toNumber(r.NUMERIC_SCALE) ?? 0,
      PSEUDO_COLUMN:  VersionColumnPseudo.notPseudo,
    }));
  }

  /**
   * Describe columns updated when a row is updated (pseudo-columns
   * like row change timestamp). IBM i exposes this via
   * QSYS2.SYSCOLUMNS where the column is a row change timestamp.
   *
   * @param {object} opts
   * @param {string} opts.schema
   * @param {string} opts.table
   * @returns {Promise<object[]>}
   */
  async getVersionColumns(opts = {}) {
    const sql = `SELECT COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE
                 FROM QSYS2.SYSCOLUMNS
                 WHERE TABLE_SCHEMA = ?
                   AND TABLE_NAME  = ?
                   AND IS_ROW_CHANGE_TIMESTAMP = 'YES'`;
    const params = [String(opts.schema || '').toUpperCase(), String(opts.table || '').toUpperCase()];
    const rows = await this.#connection.query(sql, params);
    return rows.map(r => ({
      SCOPE:          BestRowScope.temporary,
      COLUMN_NAME:    r.COLUMN_NAME,
      DATA_TYPE:      JdbcType.TIMESTAMP,
      TYPE_NAME:      'TIMESTAMP',
      COLUMN_SIZE:    toNumber(r.LENGTH) ?? 26,
      BUFFER_LENGTH:  0,
      DECIMAL_DIGITS: toNumber(r.NUMERIC_SCALE) ?? 6,
      PSEUDO_COLUMN:  VersionColumnPseudo.isPseudo,
    }));
  }

  // ─── Foreign key discovery ────────────────────────────────────────

  /**
   * List imported foreign keys (keys that reference *other* tables).
   * @param {object} opts
   * @param {string} opts.schema
   * @param {string} opts.table
   * @returns {Promise<object[]>}
   */
  async getImportedKeys(opts = {}) {
    const sql = `SELECT PK.TABLE_SCHEMA  AS PKTABLE_SCHEMA,
                        PK.TABLE_NAME    AS PKTABLE_NAME,
                        PK.COLUMN_NAME   AS PKCOLUMN_NAME,
                        FK.TABLE_SCHEMA  AS FKTABLE_SCHEMA,
                        FK.TABLE_NAME    AS FKTABLE_NAME,
                        FK.COLUMN_NAME   AS FKCOLUMN_NAME,
                        C.ORDINAL_POSITION AS KEY_SEQ,
                        C.UPDATE_RULE,
                        C.DELETE_RULE,
                        C.CONSTRAINT_NAME AS FK_NAME,
                        PKC.CONSTRAINT_NAME AS PK_NAME
                 FROM QSYS2.SYSREFCST C
                 JOIN QSYS2.SYSKEYCST  FK  ON C.CONSTRAINT_NAME  = FK.CONSTRAINT_NAME
                                           AND C.CONSTRAINT_SCHEMA = FK.TABLE_SCHEMA
                 JOIN QSYS2.SYSKEYCST  PKC ON C.UNIQUE_CONSTRAINT_NAME  = PKC.CONSTRAINT_NAME
                                           AND C.UNIQUE_CONSTRAINT_SCHEMA = PKC.TABLE_SCHEMA
                 JOIN QSYS2.SYSCOLUMNS PK  ON PKC.TABLE_SCHEMA = PK.TABLE_SCHEMA
                                           AND PKC.TABLE_NAME  = PK.TABLE_NAME
                                           AND PKC.COLUMN_NAME = PK.COLUMN_NAME
                 JOIN QSYS2.SYSCOLUMNS FK2 ON FK.TABLE_SCHEMA  = FK2.TABLE_SCHEMA
                                           AND FK.TABLE_NAME    = FK2.TABLE_NAME
                                           AND FK.COLUMN_NAME   = FK2.COLUMN_NAME
                 WHERE FK.TABLE_SCHEMA = ?
                   AND FK.TABLE_NAME  = ?`;
    const params = [String(opts.schema || '').toUpperCase(), String(opts.table || '').toUpperCase()];
    try {
      const rows = await this.#connection.query(sql, params);
      return rows.map(mapExportedKeyRow);
    } catch {
      return [];
    }
  }

  /**
   * List exported foreign keys (keys that *this* table is referenced by).
   * @param {object} opts
   * @param {string} opts.schema
   * @param {string} opts.table
   * @returns {Promise<object[]>}
   */
  async getExportedKeys(opts = {}) {
    const sql = `SELECT PK.TABLE_SCHEMA  AS PKTABLE_SCHEMA,
                        PK.TABLE_NAME    AS PKTABLE_NAME,
                        PK.COLUMN_NAME   AS PKCOLUMN_NAME,
                        FK.TABLE_SCHEMA  AS FKTABLE_SCHEMA,
                        FK.TABLE_NAME    AS FKTABLE_NAME,
                        FK.COLUMN_NAME   AS FKCOLUMN_NAME,
                        C.ORDINAL_POSITION AS KEY_SEQ,
                        C.UPDATE_RULE,
                        C.DELETE_RULE,
                        C.CONSTRAINT_NAME AS FK_NAME,
                        PKC.CONSTRAINT_NAME AS PK_NAME
                 FROM QSYS2.SYSREFCST C
                 JOIN QSYS2.SYSKEYCST  PKC ON C.UNIQUE_CONSTRAINT_NAME  = PKC.CONSTRAINT_NAME
                                           AND C.UNIQUE_CONSTRAINT_SCHEMA = PKC.TABLE_SCHEMA
                 JOIN QSYS2.SYSKEYCST  FK  ON C.CONSTRAINT_NAME  = FK.CONSTRAINT_NAME
                                           AND C.CONSTRAINT_SCHEMA = FK.TABLE_SCHEMA
                 JOIN QSYS2.SYSCOLUMNS PK  ON PKC.TABLE_SCHEMA = PK.TABLE_SCHEMA
                                           AND PKC.TABLE_NAME  = PK.TABLE_NAME
                                           AND PKC.COLUMN_NAME = PK.COLUMN_NAME
                 WHERE PK.TABLE_SCHEMA = ?
                   AND PK.TABLE_NAME  = ?`;
    const params = [String(opts.schema || '').toUpperCase(), String(opts.table || '').toUpperCase()];
    try {
      const rows = await this.#connection.query(sql, params);
      return rows.map(mapExportedKeyRow);
    } catch {
      return [];
    }
  }

  /**
   * Cross-reference: describe the foreign-key columns in one table
   * that reference the primary-key columns in another table.
   * @param {object} opts
   * @param {string} opts.primarySchema
   * @param {string} opts.primaryTable
   * @param {string} opts.foreignSchema
   * @param {string} opts.foreignTable
   * @returns {Promise<object[]>}
   */
  async getCrossReference(opts = {}) {
    const sql = `SELECT PK.TABLE_SCHEMA  AS PKTABLE_SCHEMA,
                        PK.TABLE_NAME    AS PKTABLE_NAME,
                        PK.COLUMN_NAME   AS PKCOLUMN_NAME,
                        FK.TABLE_SCHEMA  AS FKTABLE_SCHEMA,
                        FK.TABLE_NAME    AS FKTABLE_NAME,
                        FK.COLUMN_NAME   AS FKCOLUMN_NAME,
                        C.ORDINAL_POSITION AS KEY_SEQ,
                        C.UPDATE_RULE,
                        C.DELETE_RULE,
                        C.CONSTRAINT_NAME AS FK_NAME,
                        PKC.CONSTRAINT_NAME AS PK_NAME
                 FROM QSYS2.SYSREFCST C
                 JOIN QSYS2.SYSKEYCST  PKC ON C.UNIQUE_CONSTRAINT_NAME  = PKC.CONSTRAINT_NAME
                                           AND C.UNIQUE_CONSTRAINT_SCHEMA = PKC.TABLE_SCHEMA
                 JOIN QSYS2.SYSKEYCST  FK  ON C.CONSTRAINT_NAME  = FK.CONSTRAINT_NAME
                                           AND C.CONSTRAINT_SCHEMA = FK.TABLE_SCHEMA
                 JOIN QSYS2.SYSCOLUMNS PK  ON PKC.TABLE_SCHEMA = PK.TABLE_SCHEMA
                                           AND PKC.TABLE_NAME  = PK.TABLE_NAME
                                           AND PKC.COLUMN_NAME = PK.COLUMN_NAME
                 WHERE PK.TABLE_SCHEMA = ?
                   AND PK.TABLE_NAME  = ?
                   AND FK.TABLE_SCHEMA = ?
                   AND FK.TABLE_NAME  = ?`;
    const params = [
      String(opts.primarySchema || '').toUpperCase(),
      String(opts.primaryTable || '').toUpperCase(),
      String(opts.foreignSchema || '').toUpperCase(),
      String(opts.foreignTable || '').toUpperCase(),
    ];
    try {
      const rows = await this.#connection.query(sql, params);
      return rows.map(mapExportedKeyRow);
    } catch {
      return [];
    }
  }

  // ─── Procedure / function discovery ──────────────────────────────

  /**
   * List stored procedures.
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.procedure]
   * @returns {Promise<object[]>}
   */
  async getProcedures(opts = {}) {
    let sql = `SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME, ROUTINE_NAME,
                      ROUTINE_TYPE, EXTERNAL_NAME, SQL_DATA_ACCESS
               FROM QSYS2.SYSPROCS`;
    const conditions = [];
    const params = [];
    if (opts.schema)    { conditions.push(`SPECIFIC_SCHEMA = ?`); params.push(opts.schema.toUpperCase()); }
    if (opts.procedure) { conditions.push(`ROUTINE_NAME LIKE ?`); params.push(opts.procedure.toUpperCase()); }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY SPECIFIC_SCHEMA, ROUTINE_NAME`;
    return this.#connection.query(sql, params);
  }

  /**
   * List procedure parameters.
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.procedure]
   * @returns {Promise<object[]>}
   */
  async getProcedureColumns(opts = {}) {
    let sql = `SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME, PARAMETER_NAME,
                      PARAMETER_MODE, ORDINAL_POSITION, DATA_TYPE,
                      NUMERIC_PRECISION, NUMERIC_SCALE, CHARACTER_MAXIMUM_LENGTH
               FROM QSYS2.SYSPARMS`;
    const conditions = [];
    const params = [];
    if (opts.schema)    { conditions.push(`SPECIFIC_SCHEMA = ?`); params.push(opts.schema.toUpperCase()); }
    if (opts.procedure) { conditions.push(`SPECIFIC_NAME LIKE ?`); params.push(opts.procedure.toUpperCase()); }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION`;
    return this.#connection.query(sql, params);
  }

  /**
   * List user-defined functions (UDFs).
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.functionName]
   * @returns {Promise<object[]>}
   */
  async getFunctions(opts = {}) {
    let sql = `SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME, ROUTINE_NAME,
                      ROUTINE_TYPE, EXTERNAL_NAME, SQL_DATA_ACCESS,
                      ROUTINE_TEXT
               FROM QSYS2.SYSFUNCS`;
    const conditions = [];
    const params = [];
    if (opts.schema)       { conditions.push(`SPECIFIC_SCHEMA = ?`); params.push(opts.schema.toUpperCase()); }
    if (opts.functionName) { conditions.push(`ROUTINE_NAME LIKE ?`);  params.push(opts.functionName.toUpperCase()); }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY SPECIFIC_SCHEMA, ROUTINE_NAME`;
    const rows = await this.#connection.query(sql, params);
    return rows.map(mapFunctionRow);
  }

  /**
   * List function parameters / return columns.
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.functionName]
   * @param {string} [opts.columnName]
   * @returns {Promise<object[]>}
   */
  async getFunctionColumns(opts = {}) {
    let sql = `SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME, ROUTINE_NAME,
                      PARAMETER_NAME, PARAMETER_MODE, ORDINAL_POSITION,
                      DATA_TYPE, NUMERIC_PRECISION, NUMERIC_SCALE,
                      CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, REMARKS
               FROM QSYS2.SYSPARMS`;
    const conditions = [];
    const params = [];
    if (opts.schema)       { conditions.push(`SPECIFIC_SCHEMA = ?`); params.push(opts.schema.toUpperCase()); }
    if (opts.functionName) { conditions.push(`SPECIFIC_NAME LIKE ?`); params.push(opts.functionName.toUpperCase()); }
    if (opts.columnName)   { conditions.push(`PARAMETER_NAME LIKE ?`); params.push(normalizePattern(opts.columnName)); }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION`;
    const rows = await this.#connection.query(sql, params);
    return rows.map(mapFunctionColumnRow);
  }

  // ─── UDT discovery ───────────────────────────────────────────────

  /**
   * List user-defined types (DISTINCT types on IBM i).
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.typeName]
   * @returns {Promise<object[]>}
   */
  async getUDTs(opts = {}) {
    let sql = `SELECT USER_DEFINED_TYPE_SCHEMA, USER_DEFINED_TYPE_NAME,
                      SOURCE_TYPE, REMARKS,
                      SMALLINT(CASE SOURCE_TYPE
                        WHEN 'BIGINT' THEN -5 WHEN 'CHAR' THEN 1
                        WHEN 'CHARACTER' THEN 1 WHEN 'GRAPHIC' THEN 1
                        WHEN 'NUMERIC' THEN 2 WHEN 'DECIMAL' THEN 3
                        WHEN 'INTEGER' THEN 4 WHEN 'SMALLINT' THEN 5
                        WHEN 'REAL' THEN 6 WHEN 'FLOAT' THEN 8
                        WHEN 'DOUBLE' THEN 8 WHEN 'VARCHAR' THEN 12
                        WHEN 'VARGRAPHIC' THEN 12 WHEN 'DATALINK' THEN 70
                        WHEN 'DATE' THEN 91 WHEN 'TIME' THEN 92
                        WHEN 'TIMESTMP' THEN 93 WHEN 'TIMESTAMP' THEN 93
                        WHEN 'BLOB' THEN 2004 WHEN 'CLOB' THEN 2005
                        WHEN 'DBCLOB' THEN 2005 ELSE NULL END) AS BASE_TYPE
               FROM QSYS2.SYSTYPES`;
    const conditions = [];
    const params = [];
    pushLike(conditions, params, 'USER_DEFINED_TYPE_SCHEMA', opts.schema);
    pushLike(conditions, params, 'USER_DEFINED_TYPE_NAME', opts.typeName);
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY USER_DEFINED_TYPE_SCHEMA, USER_DEFINED_TYPE_NAME`;
    const rows = await this.#connection.query(sql, params);
    return rows.map(r => ({
      TYPE_CAT:   null,
      TYPE_SCHEM: r.USER_DEFINED_TYPE_SCHEMA,
      TYPE_NAME:  r.USER_DEFINED_TYPE_NAME,
      CLASS_NAME: `java.lang.Object`,
      DATA_TYPE:  JdbcType.DISTINCT,
      REMARKS:    r.REMARKS ?? '',
      BASE_TYPE:  r.BASE_TYPE ?? null,
    }));
  }

  // ─── Super-types / super-tables (IBM i has no SQL super-type hierarchy) ──

  getSuperTypes()  { return []; }
  getSuperTables() { return []; }

  /**
   * List client-info properties supported by the server.
   * @returns {object[]}
   */
  getClientInfoProperties() {
    return [
      { NAME: 'ApplicationName',  MAX_LEN: 128, DEFAULT_VALUE: '', DESCRIPTION: 'The name of the application' },
      { NAME: 'ClientUser',       MAX_LEN: 128, DEFAULT_VALUE: '', DESCRIPTION: 'The user name on whose behalf the connection is made' },
      { NAME: 'ClientHostname',   MAX_LEN: 128, DEFAULT_VALUE: '', DESCRIPTION: 'The hostname of the client' },
      { NAME: 'ClientAccounting',MAX_LEN: 128, DEFAULT_VALUE: '', DESCRIPTION: 'Accounting information' },
      { NAME: 'ClientProgramId', MAX_LEN: 128, DEFAULT_VALUE: '', DESCRIPTION: 'The program ID of the client' },
    ];
  }

  // ─── Capability reporting (mirrors JTOpen support answers) ───────

  allProceduresAreCallable()             { return true; }
  allTablesAreSelectable()               { return true; }
  dataDefinitionCausesTransactionCommit(){ return true; }
  dataDefinitionIgnoredInTransactions()  { return false; }
  doesMaxRowSizeIncludeBlobs()           { return true; }

  getCatalogSeparator()  { return '.'; }
  getCatalogTerm()       { return 'system'; }
  getSchemaTerm()        { return 'Library'; }
  getProcedureTerm()     { return 'Procedure'; }

  getDefaultTransactionIsolation() { return 1; }  // READ_UNCOMMITTED
  getDriverMajorVersion()          { return 1; }
  getDriverMinorVersion()          { return 0; }
  getDriverName()                   { return 'js400'; }
  getDriverVersion()                { return '1.0'; }

  getDatabaseMajorVersion()         { return 7; }
  getDatabaseMinorVersion()         { return 5; }
  getDatabaseProductName()          { return 'IBM i'; }
  getDatabaseProductVersion()       { return '7.5'; }

  getExtraNameCharacters()          { return '@#'; }
  getIdentifierQuoteString()        { return '"'; }
  getSQLKeywords()                  { return SQL_KEYWORDS.join(','); }
  getNumericFunctions()             { return NUMERIC_FUNCTIONS.join(','); }
  getStringFunctions()              { return STRING_FUNCTIONS.join(','); }
  getSystemFunctions()              { return SYSTEM_FUNCTIONS.join(','); }
  getTimeDateFunctions()            { return TIME_DATE_FUNCTIONS.join(','); }
  getSearchStringEscape()           { return '\\'; }
  getURL()                          { return ''; }
  getUserName()                     { return ''; }

  getJDBCMajorVersion()             { return 4; }
  getJDBCMinorVersion()             { return 2; }
  getSQLStateType()                 { return 2; }  // SQL99
  getResultSetHoldability()         { return 2; }  // closeCursorsAtCommit

  // ─── Max-limit constants (IBM i values from JTOpen) ──────────────

  getMaxBinaryLiteralLength()  { return 32739; }
  getMaxCatalogNameLength()    { return 10; }
  getMaxCharLiteralLength()    { return 32739; }
  getMaxColumnNameLength()     { return 128; }
  getMaxColumnsInGroupBy()     { return 8000; }
  getMaxColumnsInIndex()       { return 120; }
  getMaxColumnsInOrderBy()     { return 10000; }
  getMaxColumnsInSelect()      { return 8000; }
  getMaxColumnsInTable()       { return 8000; }
  getMaxConnections()          { return 0; }  // no limit
  getMaxCursorNameLength()     { return 128; }
  getMaxIndexLength()          { return 2000; }
  getMaxProcedureNameLength()  { return 128; }
  getMaxRowSize()              { return 32766; }
  getMaxSchemaNameLength()     { return 128; }
  getMaxStatementLength()      { return 1048576; }
  getMaxStatements()           { return 0; }  // no limit
  getMaxTableNameLength()      { return 128; }
  getMaxTablesInSelect()       { return 1000; }
  getMaxUserNameLength()       { return 10; }

  // ─── supports* capability queries (JTOpen IBM i answers) ────────

  supportsAlterTableWithAddColumn()     { return true; }
  supportsAlterTableWithDropColumn()    { return true; }
  supportsANSI92EntryLevelSQL()         { return true; }
  supportsANSI92IntermediateSQL()       { return false; }
  supportsANSI92FullSQL()               { return false; }
  supportsBatchUpdates()                { return true; }
  supportsCatalogsInDataManipulation()  { return false; }
  supportsCatalogsInIndexDefinitions()  { return false; }
  supportsCatalogsInPrivilegeDefinitions() { return false; }
  supportsCatalogsInTableDefinitions()  { return false; }
  supportsColumnAliasing()              { return true; }
  supportsConvert()                     { return false; }
  supportsCoreSQLGrammar()              { return true; }
  supportsCorrelatedSubqueries()        { return true; }
  supportsDataDefinitionAndDataManipulationTransactions() { return true; }
  supportsDataManipulationTransactionsOnly()              { return false; }
  supportsDifferentTablesForCorrelConstraints()          { return false; }
  supportsExpressionsInOrderBy()         { return true; }
  supportsExtendedSQLGrammar()          { return false; }
  supportsFullOuterJoins()              { return true; }
  supportsGetGeneratedKeys()            { return true; }
  supportsGroupBy()                     { return true; }
  supportsGroupByBeyondSelect()         { return true; }
  supportsGroupByUnrelated()            { return true; }
  supportsIntegrityEnhancementFacility(){ return false; }
  supportsLikeEscapeClause()            { return true; }
  supportsLimitedOuterJoins()           { return true; }
  supportsMinimumSQLGrammar()           { return true; }
  supportsMixedCaseIdentifiers()        { return false; }
  supportsMixedCaseQuotedIdentifiers()  { return true; }
  // Multi-result-set machinery exists on the Statement API (the
  // #pendingResults queue, getMoreResults()), but no engine/protocol
  // path populates additional result sets from a CALL reply today, so
  // JDBC callers that probe these capabilities will otherwise get
  // false positives. Report false until the engine actually drains
  // server-side extra result sets — then flip these back to true.
  supportsMultipleOpenResults()         { return false; }
  supportsMultipleResultSets()          { return false; }
  supportsMultipleTransactions()        { return true; }
  supportsNamedParameters()            { return true; }
  supportsNonNullableColumns()          { return true; }
  supportsNonEscapedSearchStrings()     { return true; }
  supportsOpenCursorsAcrossCommit()     { return true; }
  supportsOpenCursorsAcrossRollback()   { return false; }
  supportsOpenStatementsAcrossCommit()   { return true; }
  supportsOpenStatementsAcrossRollback() { return false; }
  supportsOrderByUnrelated()           { return true; }
  supportsOuterJoins()                 { return true; }
  // Positioned delete/update are live-qualified on IBM i:
  // `Statement.setCursorName()` now reaches CREATE_RPB's CURSOR_NAME
  // code point using the server CCSID (matching JTOpen's converter
  // path), and `UPDATE/DELETE ... WHERE CURRENT OF <cursor>` succeeds
  // end-to-end on a live IBM i host against a real open cursor.
  supportsPositionedDelete()           { return true; }
  supportsPositionedUpdate()           { return true; }
  supportsResultSetConcurrency(conc, type) {
    // Only CONCUR_READ_ONLY is honored today; no updatable result-set
    // machinery exists. Accept any type that is itself supported.
    if (conc !== 1007) return false; // not CONCUR_READ_ONLY
    return this.supportsResultSetType(type);
  }
  supportsResultSetType(type) {
    // FORWARD_ONLY is the native host cursor shape.
    // SCROLL_INSENSITIVE is honored via in-memory row buffering.
    // SCROLL_SENSITIVE requires server-side sensitive scroll, which is
    // not wired — report false so JDBC-aware callers don't assume live
    // re-read semantics they will not get.
    if (type === 1003 /* FORWARD_ONLY */) return true;
    if (type === 1004 /* SCROLL_INSENSITIVE */) return true;
    return false;
  }
  supportsSavepoints()                  { return true; }
  supportsSchemasInDataManipulation()   { return true; }
  supportsSchemasInIndexDefinitions()   { return true; }
  supportsSchemasInPrivilegeDefinitions() { return true; }
  supportsSchemasInTableDefinitions()   { return true; }
  supportsSelectForUpdate()             { return true; }
  supportsStatementPooling()            { return false; }
  supportsStoredFunctionsUsingCallSyntax() { return true; }
  supportsStoredProcedures()            { return true; }
  supportsSubqueriesInComparisons()     { return true; }
  supportsSubqueriesInExists()          { return true; }
  supportsSubqueriesInIns()             { return true; }
  supportsSubqueriesInQuantifieds()     { return true; }
  supportsTableCorrelationNames()       { return true; }
  supportsTransactionIsolation(level)   { return true; }
  supportsTransactions()                { return true; }
  supportsUnion()                       { return true; }
  supportsUnionAll()                    { return true; }
  supportsTypeConversion(_fromType, _toType) { return false; }

  // ─── Null ordering ──────────────────────────────────────────────

  nullPlusNonNullIsNull()     { return true; }
  nullsAreSortedAtEnd()       { return false; }
  nullsAreSortedAtStart()     { return true; }
  nullsAreSortedHigh()        { return false; }
  nullsAreSortedLow()         { return true; }

  // ─── Other capability booleans ──────────────────────────────────

  insertsAreDetected(_type)  { return false; }
  isCatalogAtStart()         { return true; }
  isReadOnly()               { return false; }
  locatorsUpdateCopy()       { return true; }
  deletesAreDetected(_type)  { return false; }
  updatesAreDetected(_type)  { return false; }
  othersDeletesAreVisible(_type) { return true; }
  othersInsertsAreVisible(_type) { return true; }
  othersUpdatesAreVisible(_type) { return true; }
  ownDeletesAreVisible(_type)   { return true; }
  ownInsertsAreVisible(_type)   { return true; }
  ownUpdatesAreVisible(_type)   { return true; }
  rowIdSupported()               { return true; }
  getRowIdLifetime()            { return 2; } // ROWID_VALID_TRANSACTION

  getMaxLogicalLobSize()        { return 0; } // no limit
  supportsRefCursors()          { return false; }
  supportsSharding()            { return false; }
}
