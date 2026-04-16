export interface ConnectOptions {
  host?: string;
  user?: string;
  password?: string;
  libraries?: string[];
  [key: string]: unknown;
}

export class DbConnection {}
export class Statement {}
export class PreparedStatement {}
export class Savepoint {}

export function connect(options: ConnectOptions): Promise<DbConnection>;
export function createPool(options: ConnectOptions): unknown;
export function parseJdbcUrl(url: string): Record<string, unknown>;
