/**
 * Signon info reply parser.
 *
 * Reply layout:
 *   0-19   Standard 20-byte header (repId = 0xF004)
 *   20-23  Return code (uint32)
 *   24+    Optional LL/CP pairs:
 *          - CP 0x111F: Job name (with CCSID prefix)
 *          - CP 0x1114: Server CCSID (uint32)
 *
 * Upstream: SignonInfoRep.java, AS400ImplRemote.java
 * @module auth/protocol/SignonInfoRep
 */

import { Trace } from '../../core/Trace.js';
import { AS400SecurityError, DatastreamError } from '../../core/errors.js';
import { CP } from '../constants.js';

/** Server CCSID code point (not in the shared CP map). */
const CP_SERVER_CCSID = 0x1114;

export class SignonInfoRep {

  /**
   * Parse a signon info reply.
   *
   * @param {Buffer} buf
   * @returns {{
   *   returnCode: number,
   *   jobNameBytes: Buffer|null,
   *   serverCCSID: number,
   * }}
   */
  static parse(buf) {
    if (!buf || buf.length < 24) {
      throw new DatastreamError('Signon info reply too short', {
        bufferOffsets: { start: 0, end: buf?.length ?? 0 },
      });
    }

    const returnCode = buf.readUInt32BE(20);

    let jobNameBytes = null;
    let serverCCSID = 0;

    // Scan LL/CP area starting at offset 24
    let offset = 24;
    while (offset < buf.length - 5) {
      const ll = buf.readUInt32BE(offset);
      if (ll < 6 || offset + ll > buf.length) break;
      const cp = buf.readUInt16BE(offset + 4);

      switch (cp) {
        case CP.JOB_NAME: {
          // Job name with CCSID prefix: LL(4) + CP(2) + CCSID(4) + data
          const dataLen = ll - 10;
          if (dataLen > 0 && offset + 10 + dataLen <= buf.length) {
            jobNameBytes = Buffer.alloc(dataLen);
            buf.copy(jobNameBytes, 0, offset + 10, offset + 10 + dataLen);
          }
          break;
        }
        case CP_SERVER_CCSID: {
          // Server CCSID: LL(4) + CP(2) + uint32
          if (ll >= 10) {
            serverCCSID = buf.readUInt32BE(offset + 6);
          }
          break;
        }
      }

      offset += ll;
    }

    if (returnCode !== 0) {
      throw new AS400SecurityError(
        `Signon failed with RC=0x${returnCode.toString(16)}`,
        { returnCode }
      );
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, `Signon info reply: RC=0, serverCCSID=${serverCCSID}`);
    }

    return { returnCode, jobNameBytes, serverCCSID };
  }
}
