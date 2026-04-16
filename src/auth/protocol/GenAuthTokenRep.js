/**
 * Generate authentication token reply parser.
 *
 * Reply layout:
 *   0-19   Standard 20-byte header
 *   20-23  Return code (uint32)
 *   24-29  (reserved or padding)
 *   30-61  Profile token (32 bytes) at offset 30
 *
 * Upstream: SignonGenAuthTokenReplyDS.java
 * @module auth/protocol/GenAuthTokenRep
 */

import { Trace } from '../../core/Trace.js';
import { AS400SecurityError, DatastreamError } from '../../core/errors.js';

export class GenAuthTokenRep {

  /**
   * Parse a gen-auth-token reply.
   *
   * @param {Buffer} buf
   * @returns {{ returnCode: number, profileToken: Buffer|null }}
   */
  static parse(buf) {
    if (!buf || buf.length < 24) {
      throw new DatastreamError('Gen auth token reply too short', {
        bufferOffsets: { start: 0, end: buf?.length ?? 0 },
      });
    }

    const returnCode = buf.readUInt32BE(20);

    let profileToken = null;
    if (buf.length >= 62) {
      profileToken = Buffer.alloc(32);
      buf.copy(profileToken, 0, 30, 62);
    }

    if (returnCode !== 0) {
      throw new AS400SecurityError(
        `Generate auth token failed with RC=0x${returnCode.toString(16)}`,
        { returnCode }
      );
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, 'Gen auth token reply: success');
    }

    return { returnCode, profileToken };
  }
}
