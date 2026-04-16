/**
 * Exchange-attributes request builder.
 *
 * Sends client version, data stream level, and optional client seed to the
 * signon server. The server replies with password level, server seed,
 * server version/level, and job name.
 *
 * Request layout:
 *   0-19   Standard 20-byte header (reqRepId = 0x7003 for signon, 0x7103 for hostcnn)
 *   20-29  LL/CP 0x1101: Client version (uint32 = 1)
 *   30-37  LL/CP 0x1102: Client data stream level (uint16 = 10)
 *   38-51  LL/CP 0x1103: Client seed (8 bytes) -- optional
 *
 * Upstream: SignonExchangeAttributeReq.java
 * @module auth/protocol/SignonExchangeReq
 */

import { randomBytes } from 'node:crypto';
import { Trace } from '../../core/Trace.js';
import { ServerID } from '../../core/constants.js';
import {
  SIGNON_EXCHANGE_ATTR_REQ,
  HOSTCNN_EXCHANGE_ATTR_REQ,
  CP,
} from '../constants.js';

export class SignonExchangeReq {

  /**
   * Build an exchange-attributes request.
   *
   * @param {object} opts
   * @param {number} opts.serverId - ServerID.SIGNON (0xE009) or ServerID.HOSTCNN (0xE00B)
   * @param {Buffer|Uint8Array} [opts.clientSeed] - 8-byte seed; generated if omitted
   * @returns {{ buffer: Buffer, clientSeed: Buffer }}
   */
  static build(opts) {
    const { serverId } = opts;
    const includeSeed = opts.clientSeed !== undefined || true;
    const clientSeed = opts.clientSeed
      ? Buffer.from(opts.clientSeed)
      : randomBytes(8);

    const totalLen = includeSeed ? 52 : 38;
    const reqRepId = serverId === ServerID.SIGNON
      ? SIGNON_EXCHANGE_ATTR_REQ
      : HOSTCNN_EXCHANGE_ATTR_REQ;
    const clientLevel = serverId === ServerID.SIGNON ? 10 : 0;

    const buf = Buffer.alloc(totalLen);

    // Header (20 bytes)
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt16BE(0x0000, 4);    // headerID
    buf.writeUInt16BE(serverId, 6);
    buf.writeUInt32BE(0, 8);         // csInstance
    buf.writeUInt32BE(0, 12);        // correlation
    buf.writeUInt16BE(0, 16);        // templateLen
    buf.writeUInt16BE(reqRepId, 18);

    // Client version: LL=10, CP=0x1101, value=1
    buf.writeUInt32BE(10, 20);
    buf.writeUInt16BE(CP.CLIENT_VERSION, 24);
    buf.writeUInt32BE(1, 26);

    // Client data stream level: LL=8, CP=0x1102, value=10 (or 0 for hostcnn)
    buf.writeUInt32BE(8, 30);
    buf.writeUInt16BE(CP.CLIENT_LEVEL, 34);
    buf.writeUInt16BE(clientLevel, 36);

    // Client seed: LL=14, CP=0x1103, data=8 bytes
    if (includeSeed) {
      buf.writeUInt32BE(14, 38);
      buf.writeUInt16BE(CP.CLIENT_SEED, 42);
      clientSeed.copy(buf, 44, 0, 8);
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, 'Built signon exchange attributes request');
    }

    return { buffer: buf, clientSeed };
  }
}
