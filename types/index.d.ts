export class AS400 {
  constructor(host: string, user?: string, password?: string, options?: Record<string, unknown>);
  readonly host: string;
  readonly user: string;
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

export * from './datatypes';
export * as sql from './db';
