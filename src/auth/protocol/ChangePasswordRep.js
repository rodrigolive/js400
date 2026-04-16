/**
 * Change-password reply parser.
 *
 * Reply layout:
 *   0-19   Standard 20-byte header
 *   20-23  Return code (uint32)
 *   24+    Optional error messages
 *
 * Upstream: ChangePasswordRep.java
 * @module auth/protocol/ChangePasswordRep
 */

import { Trace } from '../../core/Trace.js';
import { AS400SecurityError, DatastreamError } from '../../core/errors.js';

export class ChangePasswordRep {

  /**
   * Parse a change-password reply.
   *
   * @param {Buffer} buf
   * @returns {{ returnCode: number }}
   */
  static parse(buf) {
    if (!buf || buf.length < 24) {
      throw new DatastreamError('Change password reply too short', {
        bufferOffsets: { start: 0, end: buf?.length ?? 0 },
      });
    }

    const returnCode = buf.readUInt32BE(20);

    if (returnCode !== 0) {
      throw new AS400SecurityError(
        `Change password failed with RC=0x${returnCode.toString(16)}`,
        { returnCode }
      );
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, 'Change password reply: success');
    }

    return { returnCode };
  }
}
