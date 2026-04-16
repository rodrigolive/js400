/**
 * Database metadata queries.
 *
 * Provides schema discovery through SQL catalog queries against
 * QSYS2 system views (SYSTABLES, SYSCOLUMNS, SYSINDEXES, etc.).
 * The rows are projected into a JDBC/JTOpen-shaped object model so
 * callers can use familiar metadata fields such as TYPE_NAME,
 * COLUMN_SIZE, TABLE_SCHEM, and REMARKS.
 *
 * Upstream: AS400JDBCDatabaseMetaData.java
 * @module db/api/DatabaseMetaData
 */

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
  'BIGINT',
  'DECIMAL',
  'DECFLOAT',
  'DOUBLE',
  'FLOAT',
  'INTEGER',
  'NUMERIC',
  'REAL',
  'SMALLINT',
]);

const CHARACTER_TYPES = new Set([
  'CHAR',
  'CHARACTER',
  'VARCHAR',
  'CHARACTER VARYING',
  'LONG VARCHAR',
  'CLOB',
]);

const GRAPHIC_TYPES = new Set([
  'GRAPHIC',
  'VARGRAPHIC',
  'LONG VARGRAPHIC',
  'DBCLOB',
]);

const BINARY_TYPES = new Set([
  'BINARY',
  'VARBINARY',
  'BLOB',
]);

const DATETIME_COLUMN_SIZES = Object.freeze({
  DATE: 10,
  TIME: 8,
  TIMESTAMP: 26,
});

function normalizePattern(value) {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

function pushLike(conditions, params, field, value) {
  if (!value) return;
  conditions.push(`${field} LIKE ?`);
  params.push(normalizePattern(value));
}

function toNumber(value) {
  return value == null ? null : Number(value);
}

function normalizeNullable(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized === 'NO' || normalized === 'N' || normalized === '0' ? 'NO' : 'YES';
}

function normalizeTableType(value) {
  return TABLE_TYPE_LABELS[String(value ?? '').trim().toUpperCase()] ?? String(value ?? '').trim().toUpperCase();
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

  if (NUMERIC_TYPES.has(typeName)) {
    return precision ?? length;
  }

  if (typeName in DATETIME_COLUMN_SIZES) {
    return length ?? DATETIME_COLUMN_SIZES[typeName];
  }

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

function mapSchemaRow(row) {
  return {
    ...row,
    TABLE_CATALOG: null,
    TABLE_SCHEM: row.SCHEMA_NAME,
  };
}

function mapTableRow(row) {
  const tableType = normalizeTableType(row.TABLE_TYPE);
  return {
    ...row,
    TABLE_CAT: null,
    TABLE_SCHEM: row.TABLE_SCHEMA,
    TABLE_TYPE: tableType,
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

export class DatabaseMetaData {
  #connection;

  /**
   * @param {object} connection - a Connection instance with query() method
   */
  constructor(connection) {
    this.#connection = connection;
  }

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
   * List tables.
   * @param {object} [opts]
   * @param {string} [opts.schema] - schema/library name pattern
   * @param {string} [opts.table] - table name pattern
   * @param {string} [opts.type] - TABLE, VIEW, ALIAS, etc.
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

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY TABLE_SCHEMA, TABLE_NAME`;
    const rows = await this.#connection.query(sql, params);
    return rows.map(mapTableRow);
  }

  /**
   * List columns for a table.
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.table]
   * @param {string} [opts.column] - column name pattern
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

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;
    const rows = await this.#connection.query(sql, params);
    return rows.map(mapColumnRow);
  }

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

    if (opts.schema) {
      sql += ` AND TABLE_SCHEMA = ?`;
      params.push(opts.schema.toUpperCase());
    }

    if (opts.table) {
      sql += ` AND TABLE_NAME = ?`;
      params.push(opts.table.toUpperCase());
    }

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

    if (opts.schema) {
      conditions.push(`I.TABLE_SCHEMA = ?`);
      params.push(opts.schema.toUpperCase());
    }

    if (opts.table) {
      conditions.push(`I.TABLE_NAME = ?`);
      params.push(opts.table.toUpperCase());
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY I.TABLE_SCHEMA, I.TABLE_NAME, I.INDEX_NAME, K.ORDINAL_POSITION`;
    return this.#connection.query(sql, params);
  }

  /**
   * List stored procedures.
   * @param {object} [opts]
   * @param {string} [opts.schema]
   * @param {string} [opts.procedure] - procedure name pattern
   * @returns {Promise<object[]>}
   */
  async getProcedures(opts = {}) {
    let sql = `SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME, ROUTINE_NAME,
                      ROUTINE_TYPE, EXTERNAL_NAME, SQL_DATA_ACCESS
               FROM QSYS2.SYSPROCS`;
    const conditions = [];
    const params = [];

    if (opts.schema) {
      conditions.push(`SPECIFIC_SCHEMA = ?`);
      params.push(opts.schema.toUpperCase());
    }

    if (opts.procedure) {
      conditions.push(`ROUTINE_NAME LIKE ?`);
      params.push(opts.procedure.toUpperCase());
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

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

    if (opts.schema) {
      conditions.push(`SPECIFIC_SCHEMA = ?`);
      params.push(opts.schema.toUpperCase());
    }

    if (opts.procedure) {
      conditions.push(`SPECIFIC_NAME LIKE ?`);
      params.push(opts.procedure.toUpperCase());
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION`;
    return this.#connection.query(sql, params);
  }
}
