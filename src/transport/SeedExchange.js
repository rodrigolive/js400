/**
 * Sign-on seed exchange request/reply support.
 *
 * The seed exchange is the first step in authenticating to an IBM i server.
 * Client sends a 28-byte datastream containing an 8-byte random seed.
 * Server replies with its own 8-byte seed plus a return code and attributes.
 *
 * Request layout (28 bytes total):
 *   Offset  Length  Field
 *   0       4       Total length = 28
 *   4       1       Client attributes (0x03 = supports SHA-1 + aaf)
 *   5       1       Server attributes (0x00)
 *   6       2       Server ID
 *   8       4       CS instance = 0
 *   12      4       Correlation = 0
 *   16      2       Template length = 8
 *   18      2       Request/Reply ID = 0x7001
 *   20      8       Client seed (random bytes)
 *
 * Reply layout (variable, at least 32 bytes):
 *   0       4       Total length
 *   4       2       Header ID
 *   6       2       Server ID
 *   8       4       CS instance
 *   12      4       Correlation
 *   16      2       Template length
 *   18      2       Req/Rep ID (0xF001)
 *   20      4       Return code (0 = success)
 *   24      8       Server seed
 *   32+     var     Optional LL/CP pairs
 *
 * Upstream: AS400XChgRandSeedDS.java, AS400XChgRandSeedReplyDS.java
 * @module transport/SeedExchange
 */

import { randomBytes } from 'node:crypto';
import { Trace } from '../core/Trace.js';
import { AS400SecurityError, DatastreamError } from '../core/errors.js';
import { EXCHANGE_SEED_REQ, EXCHANGE_SEED_REP } from '../core/constants.js';

/** Client attributes: 0x03 = SHA-1 + AAF support. */
const CLIENT_ATTRIBUTES = 0x03;

/**
 * Helpers for building seed exchange requests and parsing replies.
 */
export class SeedExchange {

  /**
   * Build a seed exchange request datastream.
   *
   * @param {number} serverId - Server ID from ServiceToServerID map
   * @param {Buffer} [clientSeed] - 8-byte seed; generated if omitted
   * @returns {{ buffer: Buffer, clientSeed: Buffer }}
   */
  static buildRequest(serverId, clientSeed) {
    const seed = clientSeed ?? randomBytes(8);
    const buf = Buffer.alloc(28);

    // Total length
    buf.writeUInt32BE(28, 0);
    // Client attributes at offset 4 (replaces header ID)
    buf[4] = CLIENT_ATTRIBUTES;
    // Server attributes at offset 5
    buf[5] = 0x00;
    // Server ID
    buf.writeUInt16BE(serverId, 6);
    // CS instance = 0
    buf.writeUInt32BE(0, 8);
    // Correlation = 0
    buf.writeUInt32BE(0, 12);
    // Template length = 8 (the 8-byte seed IS the template)
    buf.writeUInt16BE(8, 16);
    // Request/Reply ID = 0x7001
    buf.writeUInt16BE(EXCHANGE_SEED_REQ, 18);
    // Client seed at offset 20
    seed.copy(buf, 20, 0, 8);

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, 'Built seed exchange request');
    }

    return { buffer: buf, clientSeed: seed };
  }

  /**
   * Parse a seed exchange reply datastream.
   *
   * @param {Buffer} reply - Full reply buffer
   * @returns {{
   *   returnCode: number,
   *   serverSeed: Buffer,
   *   serverAttributes: number,
   *   aafIndicator: boolean,
   * }}
   */
  static parseReply(reply) {
    if (!reply || reply.length < 32) {
      throw new DatastreamError('Seed exchange reply too short', {
        bufferOffsets: { start: 0, end: reply?.length ?? 0 },
      });
    }

    const reqRepId = reply.readUInt16BE(18);
    // The reply hash code is 0xF001
    if (reqRepId !== EXCHANGE_SEED_REP && reqRepId !== EXCHANGE_SEED_REQ) {
      // Some implementations echo the request ID in replies
      if (Trace.isTraceOn() && Trace.isTraceWarningOn()) {
        Trace.log(Trace.WARNING, `Unexpected seed exchange reply ID: 0x${reqRepId.toString(16)}`);
      }
    }

    const returnCode = reply.readUInt32BE(20);
    const serverSeed = Buffer.alloc(8);
    reply.copy(serverSeed, 0, 24, 32);
    const serverAttributes = reply[5];

    // Check for AAF indicator code point 0x112E in optional LL/CP area
    let aafIndicator = false;
    if (reply.length > 32) {
      const aafOffset = SeedExchange.#findCodePoint(reply, 32, 0x112E);
      if (aafOffset >= 0 && reply.length > aafOffset + 6) {
        aafIndicator = reply[aafOffset + 6] === 0x01;
      }
    }

    if (returnCode !== 0) {
      throw new AS400SecurityError(`Seed exchange failed with RC=${returnCode}`, {
        returnCode,
      });
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `Seed exchange reply: RC=${returnCode}, serverAttrs=${serverAttributes}, aaf=${aafIndicator}`);
    }

    return { returnCode, serverSeed, serverAttributes, aafIndicator };
  }

  /**
   * Search for a code point in the LL/CP area of a reply.
   *
   * LL/CP format:
   *   offset+0: 4 bytes LL (length including LL+CP)
   *   offset+4: 2 bytes CP (code point)
   *   offset+6: data
   *
   * @param {Buffer} buf
   * @param {number} start - Offset to start searching
   * @param {number} cp    - Code point to find
   * @returns {number} Offset of the LL field, or -1 if not found
   */
  static #findCodePoint(buf, start, cp) {
    let offset = start;
    while (offset < buf.length - 5) {
      const ll = buf.readUInt32BE(offset);
      if (ll < 6 || offset + ll > buf.length) break;
      const cpVal = buf.readUInt16BE(offset + 4);
      if (cpVal === cp) return offset;
      offset += ll;
    }
    return -1;
  }
}
