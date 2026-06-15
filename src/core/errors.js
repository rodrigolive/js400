/**
 * Error taxonomy for js400.
 *
 * Upstream: AS400SecurityException.java, ErrorCompletingRequestException.java,
 *           InternalErrorException.java, ExtendedIllegalArgumentException.java
 * @module core/errors
 */

/**
 * @typedef {object} AS400ErrorDetails
 * @property {number|string|null} [returnCode]
 * @property {string|null} [hostService]
 * @property {string|null} [messageId]
 * @property {Record<string, unknown>|null} [requestMetadata]
 * @property {{ start?: number, end?: number }|null} [bufferOffsets]
 * @property {Error} [cause]
 */

/** Base error for all js400 host-related errors. */
export class AS400Error extends Error {
  /**
   * @param {string} message
   * @param {AS400ErrorDetails} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'AS400Error';
    this.hostService = details.hostService ?? null;
    this.returnCode = details.returnCode ?? null;
    this.messageId = details.messageId ?? null;
    this.requestMetadata = details.requestMetadata ?? null;
    this.bufferOffsets = details.bufferOffsets ?? null;
  }
}

/** Authentication or authorization failure. */
export class AS400SecurityError extends AS400Error {
  constructor(message, details) {
    super(message, details);
    this.name = 'AS400SecurityError';
  }
}

/** Connection unexpectedly dropped. */
export class ConnectionDroppedError extends AS400Error {
  constructor(message, details) {
    super(message, details);
    this.name = 'ConnectionDroppedError';
  }
}

/** Malformed or unexpected datastream. */
export class DatastreamError extends AS400Error {
  constructor(message, details) {
    super(message, details);
    this.name = 'DatastreamError';
  }
}

/** IBM i host message (CPF, etc.). */
export class HostMessageError extends AS400Error {
  constructor(message, details) {
    super(message, details);
    this.name = 'HostMessageError';
  }
}

/** PCML parsing or execution error. */
export class PcmlError extends AS400Error {
  constructor(message, details) {
    super(message, details);
    this.name = 'PcmlError';
  }
}

/** Print subsystem error. */
export class PrintError extends AS400Error {
  constructor(message, details) {
    super(message, details);
    this.name = 'PrintError';
  }
}

/** SQL / database error. */
export class SqlError extends AS400Error {
  constructor(message, details) {
    super(message, details);
    this.name = 'SqlError';
    this.sqlCode = details?.requestMetadata?.sqlCode
      ?? details?.returnCode ?? null;
    this.sqlState = details?.requestMetadata?.sqlState
      ?? details?.messageId ?? null;
  }
}

/**
 * Batch execution error with per-row update counts.
 *
 * Mirrors java.sql.BatchUpdateException: carries the update counts for
 * rows that succeeded before the error, plus the underlying SqlError.
 *
 * @property {number[]} updateCounts - one entry per row in the batch.
 *   Values: 1 = success (INSERT), -2 = SUCCESS_NO_INFO, -3 = EXECUTE_FAILED.
 *   The array is always the same length as the original batch.
 * @property {Array<{row: number, sqlCode: number, sqlState: string, message: string}>} rowErrors
 */
export class BatchUpdateError extends SqlError {
  constructor(message, details) {
    super(message, details);
    this.name = 'BatchUpdateError';
    this.updateCounts = details?.updateCounts ?? [];
    this.rowErrors = details?.rowErrors ?? [];
  }
}
