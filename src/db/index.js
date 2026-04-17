/**
 * Database / SQL client API.
 *
 * @module db
 */

// --- Public connection factory ---
export { connect, createPool, parseJdbcUrl } from './connect.js';

// --- Public API layer ---
export { Connection, TransactionIsolation } from './api/Connection.js';
export { DataSource, ConnectionPoolDataSource } from './api/DataSource.js';
export {
  Statement,
  SUCCESS_NO_INFO, EXECUTE_FAILED,
  RETURN_GENERATED_KEYS, NO_GENERATED_KEYS,
  CLOSE_CURRENT_RESULT, KEEP_CURRENT_RESULT, CLOSE_ALL_RESULTS,
} from './api/Statement.js';
export { PreparedStatement, SQL_NULL } from './api/PreparedStatement.js';
export { PreparedStatementCache } from './api/PreparedStatementCache.js';
export { CallableStatement } from './api/CallableStatement.js';
export {
  ResultSet, FetchDirection, ResultSetType,
  ResultSetConcurrency, ResultSetHoldability,
} from './api/ResultSet.js';
export {
  ResultSetMetaData, JdbcType, ColumnNullable,
  hostTypeToJdbc, hostTypeToClassName,
} from './api/ResultSetMetaData.js';
export {
  ParameterMetaData, ParameterMode, ParameterNullable,
} from './api/ParameterMetaData.js';
export {
  DatabaseMetaData, BestRowScope, BestRowNullable,
  VersionColumnPseudo, ForeignKeyRule,
} from './api/DatabaseMetaData.js';
export { SqlArray } from './api/SqlArray.js';
export { RowId } from './api/RowId.js';
export { SqlWarning } from './api/SqlWarning.js';

// --- LOB wrappers ---
export { Blob } from './lob/Blob.js';
export { Clob } from './lob/Clob.js';
export { SQLXML } from './lob/SQLXML.js';

// --- Pool ---
export { ConnectionPool } from './pool/ConnectionPool.js';

// --- Engine layer ---
export { DbConnection } from './engine/DbConnection.js';
export { StatementManager } from './engine/StatementManager.js';
export { CursorManager } from './engine/CursorManager.js';
export { TransactionManager, Savepoint } from './engine/TransactionManager.js';
export { LibraryList } from './engine/LibraryList.js';
export { SortSequence } from './engine/SortSequence.js';
export { PackageManager } from './engine/PackageManager.js';

// --- Protocol layer ---
export { DBRequestDS, RequestID, CodePoint, DescribeOption, FetchScroll } from './protocol/DBRequestDS.js';
export {
  parseReply, parseExchangeAttributes, parseOperationReply,
  parseFetchReply, parseSQLCA, throwIfError, getCodePointData,
  decodeTextCodePoint,
} from './protocol/DBReplyDS.js';
export {
  SqlType, parseColumnDescriptors, parseExtendedColumnDescriptors,
  sqlTypeToName, calculateRowLength, getColumnByteLength,
} from './protocol/DBDescriptors.js';
export {
  parseLobLocator, parseLobDataReply, readEntireLob,
  freeLobLocator, LobHandle,
} from './protocol/DBLobData.js';

// --- Type system ---
export {
  getTypeHandler, decodeValue, encodeValue, decodeRow, decodeRows,
} from './types/factory.js';

// --- Connection properties ---
export {
  Naming, DateFormat, TimeFormat, DateSeparator, TimeSeparator,
  DecimalSeparator, SortSequenceType, IsolationLevel, CommitMode,
  IsolationToCommitMode, defaultProperties,
  validateProperties, normalizeProperties,
} from './properties.js';
