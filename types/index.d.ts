export class AS400 {
  constructor(hostOrOpts: string | {
    host?: string;
    user?: string;
    password?: string;
    port?: number;
    secure?: boolean;
    timeout?: number;
    tlsOptions?: Record<string, unknown>;
    trace?: boolean;
    abortSignal?: AbortSignal;
    signonHandler?: Function;
  }, user?: string, password?: string);
  readonly host: string;
  readonly user: string;
  signon(): Promise<void>;
  close(): Promise<void>;
  getPasswordLevel(): number;
  getServerCCSID(): number;
  getSignonJobName(): string;
  getSystemName(): string;
}

export class Trace {
  static isTraceOn(): boolean;
  static isTraceDiagnosticOn(): boolean;
  static log(category: number, message: string): void;
  static DIAGNOSTIC: number;
}

export class ProgramCall {}
export class ServiceProgramCall {}
export class CommandCall {}
export class ProgramParameter {}
export class DataQueue {}
export class KeyedDataQueue {}
export class OutputQueue {}
export class SpooledFile {}
export class IFSFile {}
export class IFSFileInputStream {}
export class IFSFileOutputStream {}

export class AS400Error extends Error {
  returnCode: number | string | null;
  messageId: string | null;
  hostService: string | null;
  requestMetadata: Record<string, unknown> | null;
}

export class AS400SecurityError extends AS400Error {}
export class ConnectionDroppedError extends AS400Error {}
export class DatastreamError extends AS400Error {}
export class HostMessageError extends AS400Error {}
export class SqlError extends AS400Error {}

export * from './datatypes';
export * as sql from './db';
