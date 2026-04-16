/**
 * Category-based tracing with hex dump and redaction support.
 *
 * Upstream: Trace.java
 * @module core/Trace
 */

import { createWriteStream } from 'node:fs';

/** Trace category constants (match JTOpen Trace.java). */
const DATASTREAM  = 0;
const DIAGNOSTIC  = 1;
const ERROR       = 2;
const INFORMATION = 3;
const WARNING     = 4;
const CONVERSION  = 5;
const PROXY       = 6;
const PCML        = 7;
const JDBC        = 8;

const CATEGORY_NAMES = Object.freeze([
  'DATASTREAM',
  'DIAGNOSTIC',
  'ERROR',
  'INFORMATION',
  'WARNING',
  'CONVERSION',
  'PROXY',
  'PCML',
  'JDBC',
]);

const HEX_CHARS = '0123456789ABCDEF';

/**
 * Patterns considered secrets -- any log message matching these gets redacted.
 */
const SECRET_PATTERNS = [
  /password/i,
  /profileToken/i,
  /encryptedPassword/i,
  /authentication.*token/i,
];

/**
 * Static utility class for category-based tracing.
 *
 * Usage:
 *   Trace.setTraceOn(true);
 *   Trace.setTraceDatastreamOn(true);
 *   Trace.log(Trace.DATASTREAM, 'some message');
 *   Trace.logHex(Trace.DATASTREAM, 'Seed', buffer);
 */
export class Trace {
  /* -- Category constants exposed as static fields -- */
  static DATASTREAM  = DATASTREAM;
  static DIAGNOSTIC  = DIAGNOSTIC;
  static ERROR       = ERROR;
  static INFORMATION = INFORMATION;
  static WARNING     = WARNING;
  static CONVERSION  = CONVERSION;
  static PROXY       = PROXY;
  static PCML        = PCML;
  static JDBC        = JDBC;

  /* -- Internal state (singleton / static) -- */
  static #traceOn = false;
  static #categories = new Uint8Array(9); // 0 = off, 1 = on
  static #fileName = null;
  static #fileStream = null;
  static #callbackSink = null;
  static #correlationId = null;

  // ---- Master switch ----

  static setTraceOn(on) {
    Trace.#traceOn = !!on;
  }

  static isTraceOn() {
    return Trace.#traceOn;
  }

  // ---- Per-category switches ----

  static setTraceDatastreamOn(on)  { Trace.#categories[DATASTREAM]  = on ? 1 : 0; }
  static setTraceDiagnosticOn(on)  { Trace.#categories[DIAGNOSTIC]  = on ? 1 : 0; }
  static setTraceErrorOn(on)       { Trace.#categories[ERROR]       = on ? 1 : 0; }
  static setTraceInformationOn(on) { Trace.#categories[INFORMATION] = on ? 1 : 0; }
  static setTraceWarningOn(on)     { Trace.#categories[WARNING]     = on ? 1 : 0; }
  static setTraceConversionOn(on)  { Trace.#categories[CONVERSION]  = on ? 1 : 0; }
  static setTraceProxyOn(on)       { Trace.#categories[PROXY]       = on ? 1 : 0; }
  static setTracePCMLOn(on)        { Trace.#categories[PCML]        = on ? 1 : 0; }
  static setTraceJDBCOn(on)        { Trace.#categories[JDBC]        = on ? 1 : 0; }

  static setTraceAllOn(on) {
    const val = on ? 1 : 0;
    for (let i = 0; i < Trace.#categories.length; i++) {
      Trace.#categories[i] = val;
    }
  }

  static isTraceDatastreamOn()  { return Trace.#categories[DATASTREAM]  === 1; }
  static isTraceDiagnosticOn()  { return Trace.#categories[DIAGNOSTIC]  === 1; }
  static isTraceErrorOn()       { return Trace.#categories[ERROR]       === 1; }
  static isTraceInformationOn() { return Trace.#categories[INFORMATION] === 1; }
  static isTraceWarningOn()     { return Trace.#categories[WARNING]     === 1; }
  static isTraceConversionOn()  { return Trace.#categories[CONVERSION]  === 1; }
  static isTraceProxyOn()       { return Trace.#categories[PROXY]       === 1; }
  static isTracePCMLOn()        { return Trace.#categories[PCML]        === 1; }
  static isTraceJDBCOn()        { return Trace.#categories[JDBC]        === 1; }

  static isTraceCategoryOn(category) {
    if (category < 0 || category >= Trace.#categories.length) return false;
    return Trace.#categories[category] === 1;
  }

  // ---- Sink configuration ----

  /**
   * Log to a file. Pass null to revert to console.
   * @param {string|null} path
   */
  static setFileName(path) {
    if (Trace.#fileStream) {
      Trace.#fileStream.end();
      Trace.#fileStream = null;
    }
    Trace.#fileName = path ?? null;
    if (path) {
      Trace.#fileStream = createWriteStream(path, { flags: 'a' });
    }
  }

  static getFileName() {
    return Trace.#fileName;
  }

  /**
   * Set a callback function as the trace sink.
   * Signature: (formattedLine: string) => void
   * @param {Function|null} fn
   */
  static setCallbackSink(fn) {
    Trace.#callbackSink = typeof fn === 'function' ? fn : null;
  }

  // ---- Correlation ID ----

  static setCorrelationId(id) {
    Trace.#correlationId = id ?? null;
  }

  static getCorrelationId() {
    return Trace.#correlationId;
  }

  // ---- Logging ----

  /**
   * Log a message to the active category.
   * @param {number} category - One of Trace.DATASTREAM, etc.
   * @param {string} message
   * @param {*} [extra] - Additional data (Error, number, boolean, etc.)
   */
  static log(category, message, extra) {
    if (!Trace.#traceOn) return;
    if (category < 0 || category >= Trace.#categories.length) return;
    if (!Trace.#categories[category]) return;

    const ts = new Date().toISOString();
    const catName = CATEGORY_NAMES[category] ?? 'UNKNOWN';
    const corr = Trace.#correlationId ? ` [corr=${Trace.#correlationId}]` : '';

    let line = `[${ts}] ${catName}${corr}: ${Trace.#redact(String(message))}`;

    if (extra instanceof Error) {
      line += `\n  ${extra.stack ?? extra.message}`;
    } else if (extra instanceof Uint8Array || Buffer.isBuffer(extra)) {
      line += '\n' + Trace.#formatHex(extra, 0, extra.length);
    } else if (extra !== undefined) {
      line += ` ${extra}`;
    }

    Trace.#emit(line);
  }

  /**
   * Log a hex dump of a buffer segment.
   * @param {number} category
   * @param {string} label
   * @param {Buffer|Uint8Array} data
   * @param {number} [offset=0]
   * @param {number} [length]
   */
  static logHex(category, label, data, offset = 0, length) {
    if (!Trace.#traceOn) return;
    if (category < 0 || category >= Trace.#categories.length) return;
    if (!Trace.#categories[category]) return;

    const ts = new Date().toISOString();
    const catName = CATEGORY_NAMES[category] ?? 'UNKNOWN';
    const corr = Trace.#correlationId ? ` [corr=${Trace.#correlationId}]` : '';
    const len = length ?? (data.length - offset);

    let line = `[${ts}] ${catName}${corr}: ${label} (${len} bytes)`;
    line += '\n' + Trace.#formatHex(data, offset, len);

    Trace.#emit(line);
  }

  // ---- Hex formatting ----

  /**
   * Convert a single byte to a two-character hex string.
   * @param {number} b
   * @returns {string}
   */
  static toHexString(b) {
    return HEX_CHARS[(b >> 4) & 0x0F] + HEX_CHARS[b & 0x0F];
  }

  /**
   * Convert a byte array to a hex string.
   * @param {Buffer|Uint8Array} data
   * @param {number} [offset=0]
   * @param {number} [length]
   * @returns {string}
   */
  static toHexDump(data, offset = 0, length) {
    return Trace.#formatHex(data, offset, length ?? (data.length - offset));
  }

  // ---- Internal helpers ----

  static #formatHex(data, offset, length) {
    const lines = [];
    const end = Math.min(offset + length, data.length);
    for (let i = offset; i < end; i += 16) {
      const addr = (i - offset).toString(16).padStart(6, '0');
      let hex = '';
      let ascii = '';
      for (let j = 0; j < 16; j++) {
        if (i + j < end) {
          const b = data[i + j];
          hex += Trace.toHexString(b) + ' ';
          ascii += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.';
        } else {
          hex += '   ';
          ascii += ' ';
        }
        if (j === 7) hex += ' ';
      }
      lines.push(`  ${addr}  ${hex} |${ascii}|`);
    }
    return lines.join('\n');
  }

  static #redact(message) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(message)) {
        return message.replace(/=\S+/g, '=***REDACTED***');
      }
    }
    return message;
  }

  static #emit(line) {
    if (Trace.#callbackSink) {
      Trace.#callbackSink(line);
      return;
    }
    if (Trace.#fileStream) {
      Trace.#fileStream.write(line + '\n');
      return;
    }
    console.log(line);
  }

  /**
   * Close any open file stream and reset all state.
   * Useful in tests.
   */
  static reset() {
    Trace.#traceOn = false;
    Trace.#categories.fill(0);
    if (Trace.#fileStream) {
      Trace.#fileStream.end();
      Trace.#fileStream = null;
    }
    Trace.#fileName = null;
    Trace.#callbackSink = null;
    Trace.#correlationId = null;
  }
}
