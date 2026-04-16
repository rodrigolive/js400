/**
 * Exchange-attributes reply parser.
 *
 * Reply layout:
 *   0-19   Standard 20-byte header
 *   20-23  Return code (uint32)
 *   24-29  LL/CP 0x1101: Server version (uint32 at offset 26)
 *   30-37  LL/CP 0x1102: Server level (uint16 at offset 36, or computed)
 *   38-41  Server level data
 *   42+    Variable LL/CP area:
 *          - 0x1103: Server seed (8 bytes)
 *          - 0x1119: Password level (1 byte)
 *          - 0x111F: Job name (variable, with CCSID prefix)
 *          - 0x112E: AAF indicator (1 byte)
 *
 * Upstream: SignonExchangeAttributeRep.java
 * @module auth/protocol/SignonExchangeRep
 */

import { Trace } from '../../core/Trace.js';
import { AS400SecurityError, DatastreamError } from '../../core/errors.js';
import { CP } from '../constants.js';

export class SignonExchangeRep {

  /**
   * Parse a signon exchange attributes reply.
   *
   * @param {Buffer} buf - Complete reply buffer
   * @returns {{
   *   returnCode: number,
   *   serverVersion: number,
   *   serverLevel: number,
   *   serverSeed: Buffer|null,
   *   passwordLevel: number,
   *   jobNameBytes: Buffer|null,
   *   aafIndicator: boolean,
   * }}
   */
  static parse(buf) {
    if (!buf || buf.length < 42) {
      throw new DatastreamError('Exchange attributes reply too short', {
        bufferOffsets: { start: 0, end: buf?.length ?? 0 },
      });
    }

    const returnCode = buf.readUInt32BE(20);

    // Fixed fields from the reply, per Java:
    //   24: LL=10, CP=0x1101, uint32 serverVersion at 30
    //   34: LL=8,  CP=0x1102, uint16 serverLevel at 40
    // Variable LL/CP scan starts at offset 42.
    const serverVersion = buf.readUInt32BE(30);
    const serverLevel = buf.readUInt16BE(40);

    // Scan variable LL/CP area starting at offset 42
    let serverSeed = null;
    let passwordLevel = 0;
    let jobNameBytes = null;
    let aafIndicator = false;

    let offset = 42;
    while (offset < buf.length - 5) {
      const ll = buf.readUInt32BE(offset);
      if (ll < 6 || offset + ll > buf.length) break;
      const cp = buf.readUInt16BE(offset + 4);

      switch (cp) {
        case CP.CLIENT_SEED: {
          // Server seed (reuses client seed code point 0x1103)
          serverSeed = Buffer.alloc(8);
          buf.copy(serverSeed, 0, offset + 6, offset + 6 + 8);
          break;
        }
        case CP.PASSWORD_LEVEL: {
          // Single byte password level
          passwordLevel = buf[offset + 6];
          break;
        }
        case CP.JOB_NAME: {
          // Job name with CCSID prefix: LL - 10 = data length
          const dataLen = ll - 10;
          if (dataLen > 0 && offset + 10 + dataLen <= buf.length) {
            jobNameBytes = Buffer.alloc(dataLen);
            buf.copy(jobNameBytes, 0, offset + 10, offset + 10 + dataLen);
          }
          break;
        }
        case CP.AAF_INDICATOR: {
          aafIndicator = buf[offset + 6] === 0x01;
          break;
        }
      }

      offset += ll;
    }

    if (returnCode !== 0) {
      throw new AS400SecurityError(
        `Exchange attributes failed with RC=0x${returnCode.toString(16)}`,
        { returnCode }
      );
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `Exchange attributes reply: version=${serverVersion}, level=${serverLevel}, pwdLevel=${passwordLevel}, aaf=${aafIndicator}`);
    }

    return {
      returnCode,
      serverVersion,
      serverLevel,
      serverSeed,
      passwordLevel,
      jobNameBytes,
      aafIndicator,
    };
  }
}
