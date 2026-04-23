export interface ConnectOptions {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  secure?: boolean;
  libraries?: string[];
  naming?: 'sql' | 'system';
  autoCommit?: boolean;
  trueAutoCommit?: boolean;
  blockSize?: number;
  blockCriteria?: number;
  prefetch?: number;
  lazyClose?: boolean;
  translateBinary?: boolean;
  translateHex?: boolean;
  extendedDynamic?: boolean;
  sqlPackage?: string;
  packageLibrary?: string;
  packageCache?: number;
  packageCriteria?: string;
  packageError?: string;
  holdStatements?: boolean;
  isolation?: string;
  dateFormat?: string;
  dateSeparator?: string;
  timeFormat?: string;
  timeSeparator?: string;
  decimalSeparator?: string;
  sortType?: string;
  sortLanguage?: string;
  sortTable?: string;
  sortWeight?: string;
  defaultSchema?: string;
  min?: number;
  max?: number;
  idleTimeout?: number;
  [key: string]: unknown;
}

export interface QueryResult {
  [column: string]: unknown;
}

export interface ExecuteResult {
  affectedRows: number;
  generatedKeys?: unknown[];
}

export interface BatchResult {
  updateCounts: number[];
  totalAffected: number;
}

export interface ColumnMeta {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: number;
  DATA_TYPE: string;
  TYPE_NAME: string;
  COLUMN_SIZE: number;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
  LENGTH: number;
  NUMERIC_SCALE: number;
  CCSID: number;
  COMMENTS: string;
}

export interface TableMeta {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  TABLE_TYPE: string;
  TABLE_TEXT: string;
  COMMENTS: string;
  NUMBER_ROWS: number;
  DATA_SIZE: number;
}

export class DatabaseMetaData {
  getTables(opts?: { schema?: string; table?: string; type?: string }): Promise<TableMeta[]>;
  getColumns(opts?: { schema?: string; table?: string; column?: string }): Promise<ColumnMeta[]>;
  getPrimaryKeys(opts: { schema: string; table: string }): Promise<QueryResult[]>;
  getImportedKeys(opts: { schema: string; table: string }): Promise<QueryResult[]>;
  getIndexes(opts?: { schema?: string; table?: string }): Promise<QueryResult[]>;
}

export class ResultSet {
  [Symbol.asyncIterator](): AsyncIterableIterator<QueryResult>;
  close(): Promise<void>;
}

export class PreparedStatement {
  setFetchSize(rows: number): this;
  execute(params?: unknown[], opts?: Record<string, unknown>): Promise<QueryResult[]>;
  executeForStream(params?: unknown[]): Promise<ResultSet>;
  executeBatch(paramSets: unknown[][]): Promise<BatchResult>;
  addBatch(params: unknown[]): void;
  clearBatch(): void;
  close(): Promise<void>;
}

export class Connection {
  query(sql: string, params?: unknown[]): Promise<QueryResult[]>;
  execute(sql: string, params?: unknown[], opts?: Record<string, unknown>): Promise<ExecuteResult>;
  prepare(sql: string, opts?: Record<string, unknown>): Promise<PreparedStatement>;
  close(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  begin(): Promise<void>;
  setAutoCommit(auto: boolean): void;
  setSchema(schema: string): Promise<void>;
  getSchema(): string;
  metadata(): DatabaseMetaData;
  getMetaData(): DatabaseMetaData;
  readonly dbConnection: unknown;
}

export class ConnectionPool {
  getConnection(): Promise<Connection>;
  release(conn: Connection): void;
  warmup(): Promise<void>;
  close(): Promise<void>;
}

export function connect(systemOrUrl: import('../core/AS400.js').AS400 | string | ConnectOptions, opts?: ConnectOptions): Promise<Connection>;
export function createPool(options: ConnectOptions): ConnectionPool;
export function parseJdbcUrl(url: string): Record<string, unknown>;
