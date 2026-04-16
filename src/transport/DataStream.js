/**
 * Client Access datastream 20-byte header parsing and building.
 *
 * The Client Access header is 20 bytes (HEADER_LENGTH in JTOpen's
 * ClientAccessDataStream.java). The spec mentions a "40-byte header"
 * because the typical minimum datastream is 20 bytes of fixed header
 * plus additional template/payload. We faithfully implement the 20-byte
 * fixed header but expose a HEADER_LENGTH of 20 matching JTOpen, and
 * also provide a buildPacket helper that creates an entire minimum-size
 * datastream (header + template area) for convenience.
 *
 * Header layout (big-endian):
 *   Offset  Length  Field
 *   0       4       Total length (includes header)
 *   4       2       Header ID / Client Attributes
 *   6       2       Server ID
 *   8       4       CS instance
 *   12      4       Correlation
 *   16      2       Template length
 *   18      2       Request/Reply ID
 *
 * Upstream: ClientAccessDataStream.java, DataStream.java
 * @module transport/DataStream
 */

import { Trace } from '../core/Trace.js';
import { DatastreamError } from '../core/errors.js';

/** Fixed header length in bytes. */
const HEADER_LENGTH = 20;

/** Auto-incrementing correlation counter (wraps at 2^31 - 1). */
let nextCorrelation = 1;

/**
 * DataStream helper -- static methods for building and parsing
 * Client Access datastream headers.
 */
export class DataStream {
  /** Fixed header size. */
  static HEADER_LENGTH = HEADER_LENGTH;

  /**
   * Build a complete datastream buffer.
   *
   * @param {object} opts
   * @param {number} opts.serverId     - Server ID (e.g. 0xE009 for SIGNON)
   * @param {number} opts.reqRepId     - Request/reply ID (e.g. 0x7001)
   * @param {number} [opts.templateLen=0] - Template length (fixed part after header)
   * @param {number} [opts.headerID=0]   - Header ID / client attributes byte pair
   * @param {number} [opts.csInstance=0] - CS instance
   * @param {number} [opts.correlation] - Correlation; auto-generated if omitted
   * @param {Buffer} [opts.payload]     - Optional payload after header + template
   * @param {number} [opts.totalLength] - Override total length (rarely needed)
   * @returns {Buffer}
   */
  static buildPacket(opts) {
    const {
      serverId,
      reqRepId,
      templateLen = 0,
      headerID = 0,
      csInstance = 0,
      correlation = DataStream.nextCorrelation(),
      payload,
      totalLength,
    } = opts;

    const payloadLen = payload ? payload.length : 0;
    const total = totalLength ?? (HEADER_LENGTH + templateLen + payloadLen);
    const buf = Buffer.alloc(total);

    // Offset 0: total length (uint32 BE)
    buf.writeUInt32BE(total, 0);
    // Offset 4: header ID (uint16 BE)
    buf.writeUInt16BE(headerID, 4);
    // Offset 6: server ID (uint16 BE)
    buf.writeUInt16BE(serverId, 6);
    // Offset 8: CS instance (uint32 BE)
    buf.writeUInt32BE(csInstance >>> 0, 8);
    // Offset 12: correlation (uint32 BE)
    buf.writeUInt32BE(correlation >>> 0, 12);
    // Offset 16: template length (uint16 BE)
    buf.writeUInt16BE(templateLen, 16);
    // Offset 18: request/reply ID (uint16 BE)
    buf.writeUInt16BE(reqRepId, 18);

    if (payload && payloadLen > 0) {
      payload.copy(buf, HEADER_LENGTH + templateLen);
    }

    return buf;
  }

  /**
   * Build only the 20-byte header portion.
   *
   * @param {object} opts  - Same as buildPacket but totalLength is
   *                          just the value written at offset 0.
   * @returns {Buffer} A 20-byte buffer.
   */
  static buildHeader(opts) {
    const {
      totalLength = HEADER_LENGTH,
      serverId = 0,
      reqRepId = 0,
      templateLen = 0,
      headerID = 0,
      csInstance = 0,
      correlation = 0,
    } = opts;

    const buf = Buffer.alloc(HEADER_LENGTH);
    buf.writeUInt32BE(totalLength, 0);
    buf.writeUInt16BE(headerID, 4);
    buf.writeUInt16BE(serverId, 6);
    buf.writeUInt32BE(csInstance >>> 0, 8);
    buf.writeUInt32BE(correlation >>> 0, 12);
    buf.writeUInt16BE(templateLen, 16);
    buf.writeUInt16BE(reqRepId, 18);
    return buf;
  }

  /**
   * Parse a header from a buffer.
   *
   * @param {Buffer} buf - Must be at least HEADER_LENGTH bytes.
   * @param {number} [offset=0]
   * @returns {{ totalLength: number, headerID: number, serverId: number,
   *             csInstance: number, correlation: number,
   *             templateLen: number, reqRepId: number }}
   */
  static parseHeader(buf, offset = 0) {
    if (buf.length - offset < HEADER_LENGTH) {
      throw new DatastreamError('Buffer too short for header', {
        bufferOffsets: { start: offset, end: buf.length },
      });
    }
    return {
      totalLength: buf.readUInt32BE(offset),
      headerID:    buf.readUInt16BE(offset + 4),
      serverId:    buf.readUInt16BE(offset + 6),
      csInstance:  buf.readUInt32BE(offset + 8),
      correlation: buf.readUInt32BE(offset + 12),
      templateLen: buf.readUInt16BE(offset + 16),
      reqRepId:    buf.readUInt16BE(offset + 18),
    };
  }

  /**
   * Validate that a received buffer is a proper Client Access datastream.
   * Checks the server ID byte at offset 6 starts with 0xE0.
   *
   * @param {Buffer} buf
   * @param {number} [offset=0]
   * @returns {boolean}
   */
  static isValidHeader(buf, offset = 0) {
    if (buf.length - offset < HEADER_LENGTH) return false;
    return buf[offset + 6] === 0xE0;
  }

  /**
   * Validate payload length: totalLength in header must match buffer size.
   *
   * @param {Buffer} buf
   * @param {number} [offset=0]
   * @returns {boolean}
   */
  static validateLength(buf, offset = 0) {
    if (buf.length - offset < HEADER_LENGTH) return false;
    const total = buf.readUInt32BE(offset);
    return total === buf.length - offset;
  }

  /**
   * Generate the next correlation ID.
   * @returns {number}
   */
  static nextCorrelation() {
    const id = nextCorrelation;
    nextCorrelation = nextCorrelation >= 0x7FFFFFFF ? 1 : nextCorrelation + 1;
    return id;
  }

  /**
   * Reset correlation counter (for testing).
   */
  static resetCorrelation() {
    nextCorrelation = 1;
  }

  /**
   * Read a complete frame from a readable stream.
   * Reads the 20-byte header first, extracts totalLength,
   * then reads the remainder.
   *
   * @param {{ read: (n: number) => Buffer|null }} readable
   *   A Node.js readable stream or an object with a read(n) method.
   * @returns {Promise<Buffer>} Complete datastream buffer.
   */
  static async readFrame(readable) {
    const header = await DataStream.#readExact(readable, HEADER_LENGTH);
    const totalLength = header.readUInt32BE(0);

    if (totalLength < HEADER_LENGTH) {
      throw new DatastreamError(`Invalid total length: ${totalLength}`, {
        bufferOffsets: { start: 0, end: HEADER_LENGTH },
      });
    }

    if (totalLength === HEADER_LENGTH) {
      return header;
    }

    const remaining = totalLength - HEADER_LENGTH;
    const body = await DataStream.#readExact(readable, remaining);
    const frame = Buffer.alloc(totalLength);
    header.copy(frame, 0);
    body.copy(frame, HEADER_LENGTH);

    if (Trace.isTraceOn() && Trace.isTraceDatastreamOn()) {
      Trace.logHex(Trace.DATASTREAM, 'Received frame', frame);
    }

    return frame;
  }

  /**
   * Read exactly n bytes from a readable stream.
   * @param {object} readable
   * @param {number} n
   * @returns {Promise<Buffer>}
   */
  static #readExact(readable, n) {
    return new Promise((resolve, reject) => {
      const tryRead = () => {
        const chunk = readable.read(n);
        if (chunk && chunk.length === n) {
          resolve(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return;
        }
        if (chunk && chunk.length > 0) {
          // partial read -- accumulate
          const parts = [chunk];
          let got = chunk.length;
          const onReadable = () => {
            while (got < n) {
              const more = readable.read(n - got);
              if (!more) return; // wait for more
              parts.push(more);
              got += more.length;
            }
            readable.removeListener('readable', onReadable);
            readable.removeListener('error', onError);
            readable.removeListener('end', onEnd);
            resolve(Buffer.concat(parts, n));
          };
          const onError = (err) => {
            readable.removeListener('readable', onReadable);
            readable.removeListener('end', onEnd);
            reject(err);
          };
          const onEnd = () => {
            readable.removeListener('readable', onReadable);
            readable.removeListener('error', onError);
            reject(new DatastreamError(`Stream ended after ${got} of ${n} bytes`));
          };
          readable.on('readable', onReadable);
          readable.on('error', onError);
          readable.on('end', onEnd);
          return;
        }

        // No data available yet
        const onReadable = () => {
          readable.removeListener('readable', onReadable);
          readable.removeListener('error', onError);
          readable.removeListener('end', onEnd);
          tryRead();
        };
        const onError = (err) => {
          readable.removeListener('readable', onReadable);
          readable.removeListener('end', onEnd);
          reject(err);
        };
        const onEnd = () => {
          readable.removeListener('readable', onReadable);
          readable.removeListener('error', onError);
          reject(new DatastreamError(`Stream ended before ${n} bytes available`));
        };
        readable.on('readable', onReadable);
        readable.on('error', onError);
        readable.on('end', onEnd);
      };
      tryRead();
    });
  }
}
