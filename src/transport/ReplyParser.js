/**
 * Generic reply header and code-point parser.
 *
 * Parses the 20-byte Client Access header, extracts the template area,
 * and iterates over LL/CP data items in the remainder.
 *
 * Upstream: various *Rep.java classes
 * @module transport/ReplyParser
 */

import { DataStream } from './DataStream.js';
import { DatastreamError } from '../core/errors.js';
import { Trace } from '../core/Trace.js';

/**
 * Parsed reply structure.
 * @typedef {object} ParsedReply
 * @property {object} header         - Parsed 20-byte header fields
 * @property {Buffer} template       - Template area (after header, before LL/CP)
 * @property {Map<number, Buffer[]>} codePoints - Map of CP -> array of data buffers
 * @property {Buffer} raw            - Original complete buffer
 */

export class ReplyParser {

  /**
   * Parse a complete reply datastream buffer.
   *
   * @param {Buffer} buf - Complete datastream including header
   * @returns {ParsedReply}
   */
  static parse(buf) {
    if (!buf || buf.length < DataStream.HEADER_LENGTH) {
      throw new DatastreamError('Reply buffer too short for header');
    }

    const header = DataStream.parseHeader(buf);

    if (header.totalLength > buf.length) {
      throw new DatastreamError(
        `Reply totalLength (${header.totalLength}) exceeds buffer (${buf.length})`
      );
    }

    // Extract template data
    const templateStart = DataStream.HEADER_LENGTH;
    const templateEnd = templateStart + header.templateLen;
    const template = buf.subarray(templateStart, Math.min(templateEnd, buf.length));

    // Parse LL/CP chain
    const codePoints = new Map();
    let offset = templateEnd;
    const end = header.totalLength;

    while (offset + 6 <= end) {
      const ll = buf.readUInt32BE(offset);
      if (ll < 6) {
        if (Trace.isTraceOn() && Trace.isTraceWarningOn()) {
          Trace.log(Trace.WARNING, `Invalid LL value ${ll} at offset ${offset}`);
        }
        break;
      }
      if (offset + ll > end) {
        if (Trace.isTraceOn() && Trace.isTraceWarningOn()) {
          Trace.log(Trace.WARNING, `LL/CP item at offset ${offset} extends past end of data`);
        }
        break;
      }

      const cp = buf.readUInt16BE(offset + 4);
      const data = buf.subarray(offset + 6, offset + ll);

      if (!codePoints.has(cp)) {
        codePoints.set(cp, []);
      }
      codePoints.get(cp).push(data);

      offset += ll;
    }

    return { header, template, codePoints, raw: buf };
  }

  /**
   * Get the first data buffer for a code point.
   *
   * @param {ParsedReply} parsed
   * @param {number} cp
   * @returns {Buffer|null}
   */
  static getCodePointData(parsed, cp) {
    const items = parsed.codePoints.get(cp);
    return items?.[0] ?? null;
  }

  /**
   * Get a 32-bit return code from the template area (common pattern).
   * Many replies store RC at template offset 0 (absolute offset 20).
   *
   * @param {ParsedReply} parsed
   * @param {number} [templateOffset=0]
   * @returns {number}
   */
  static getReturnCode(parsed, templateOffset = 0) {
    if (parsed.template.length < templateOffset + 4) {
      return -1;
    }
    return parsed.template.readUInt32BE(templateOffset);
  }

  /**
   * Check if a specific code point exists in the reply.
   *
   * @param {ParsedReply} parsed
   * @param {number} cp
   * @returns {boolean}
   */
  static hasCodePoint(parsed, cp) {
    return parsed.codePoints.has(cp);
  }
}
