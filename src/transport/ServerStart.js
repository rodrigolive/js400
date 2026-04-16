/**
 * Start-server request builder and reply parser.
 *
 * After seed exchange, the client sends a "start server" request containing
 * the encrypted password and user ID. The server replies with a return code
 * and optionally the server job name.
 *
 * Request layout (variable length):
 *   Offset  Length  Field
 *   0       4       Total length
 *   4       1       Client attributes (0x02 = can get job info back)
 *   5       1       Server attributes (0x00)
 *   6       2       Server ID
 *   8       4       CS instance = 0
 *   12      4       Correlation = 0
 *   16      2       Template length = 2
 *   18      2       Request/Reply ID = 0x7002
 *   20      1       Authentication scheme byte
 *   21      1       Send reply = 0x01
 *   22+     var     LL/CP: password/token (CP 0x1105 for password, 0x1115 for token)
 *   var+    var     LL/CP: user ID (CP 0x1104) -- 10-byte EBCDIC
 *
 * Reply layout:
 *   0       4       Total length
 *   4-19    header  Standard header
 *   20      4       Return code
 *   24+     var     Optional LL/CP pairs (e.g. 0x111F = job name)
 *
 * Upstream: AS400StrSvrDS.java, AS400StrSvrReplyDS.java
 * @module transport/ServerStart
 */

import { Trace } from '../core/Trace.js';
import { AS400SecurityError, DatastreamError } from '../core/errors.js';
import { START_SERVER_REQ, START_SERVER_REP, AuthScheme } from '../core/constants.js';

/** Code points. */
const CP_PASSWORD     = 0x1105;
const CP_AUTH_TOKEN   = 0x1115;
const CP_USER_ID      = 0x1104;
const CP_JOB_NAME     = 0x111F;
const CP_AAF          = 0x112F;
const CP_VERIFICATION = 0x1130;
const CP_CLIENT_IP    = 0x1131;

/**
 * Helpers for building start-server requests and parsing replies.
 */
export class ServerStart {

  /**
   * Build a start-server request datastream.
   *
   * @param {object} opts
   * @param {number} opts.serverId          - Server ID
   * @param {Buffer} opts.authenticationBytes - Encrypted password or token
   * @param {Buffer} [opts.userIdBytes]     - 10-byte EBCDIC user ID (null for token auth)
   * @param {number} [opts.authScheme=AuthScheme.PASSWORD]
   * @param {Buffer} [opts.addAuthFactor]   - Additional authentication factor (UTF-8)
   * @param {Buffer} [opts.verificationId]  - Verification ID (UTF-8)
   * @param {Buffer} [opts.clientIPAddr]    - Client IP address (UTF-8)
   * @returns {Buffer}
   */
  static buildRequest(opts) {
    const {
      serverId,
      authenticationBytes,
      userIdBytes = null,
      authScheme = AuthScheme.PASSWORD,
      addAuthFactor = null,
      verificationId = null,
      clientIPAddr = null,
    } = opts;

    // Calculate total size
    const hasUserId = userIdBytes !== null;
    let size = 22; // header (20) + template (2: auth scheme + send reply)
    size += 6 + authenticationBytes.length; // LL(4) + CP(2) + data
    if (hasUserId) size += 16; // LL(4) + CP(2) + 10 bytes user ID

    if (authScheme === AuthScheme.PASSWORD && addAuthFactor?.length > 0) {
      size += 10 + addAuthFactor.length; // LL(4) + CP(2) + CCSID(4) + data
    }
    if (verificationId?.length > 0) {
      size += 10 + verificationId.length;
    }
    if (authScheme === AuthScheme.PROFILE_TOKEN && clientIPAddr?.length > 0) {
      size += 10 + clientIPAddr.length;
    }

    const buf = Buffer.alloc(size);

    // Header
    buf.writeUInt32BE(size, 0);
    buf[4] = 0x02; // Client attributes: can get job info
    buf[5] = 0x00; // Server attributes
    buf.writeUInt16BE(serverId, 6);
    buf.writeUInt32BE(0, 8);  // CS instance
    buf.writeUInt32BE(0, 12); // Correlation
    buf.writeUInt16BE(2, 16); // Template length
    buf.writeUInt16BE(START_SERVER_REQ, 18);

    // Template: authentication scheme byte + send reply
    buf[20] = ServerStart.#authSchemeByte(authScheme, authenticationBytes.length);
    buf[21] = 0x01; // Send reply = true

    let offset = 22;

    // Password/token LL/CP
    buf.writeUInt32BE(6 + authenticationBytes.length, offset);
    const cp = (authScheme === AuthScheme.PASSWORD) ? CP_PASSWORD : CP_AUTH_TOKEN;
    buf.writeUInt16BE(cp, offset + 4);
    authenticationBytes.copy(buf, offset + 6);
    offset += 6 + authenticationBytes.length;

    // User ID LL/CP
    if (hasUserId) {
      buf.writeUInt32BE(16, offset);
      buf.writeUInt16BE(CP_USER_ID, offset + 4);
      userIdBytes.copy(buf, offset + 6, 0, 10);
      offset += 16;
    }

    // Additional auth factor
    if (authScheme === AuthScheme.PASSWORD && addAuthFactor?.length > 0) {
      buf.writeUInt32BE(10 + addAuthFactor.length, offset);
      buf.writeUInt16BE(CP_AAF, offset + 4);
      buf.writeUInt32BE(1208, offset + 6); // CCSID UTF-8
      addAuthFactor.copy(buf, offset + 10);
      offset += 10 + addAuthFactor.length;
    }

    // Verification ID
    if (verificationId?.length > 0) {
      buf.writeUInt32BE(10 + verificationId.length, offset);
      buf.writeUInt16BE(CP_VERIFICATION, offset + 4);
      buf.writeUInt32BE(1208, offset + 6);
      verificationId.copy(buf, offset + 10);
      offset += 10 + verificationId.length;
    }

    // Client IP
    if (authScheme === AuthScheme.PROFILE_TOKEN && clientIPAddr?.length > 0) {
      buf.writeUInt32BE(10 + clientIPAddr.length, offset);
      buf.writeUInt16BE(CP_CLIENT_IP, offset + 4);
      buf.writeUInt32BE(1208, offset + 6);
      clientIPAddr.copy(buf, offset + 10);
      offset += 10 + clientIPAddr.length;
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, `Built start server request (${size} bytes)`);
    }

    return buf;
  }

  /**
   * Parse a start-server reply.
   *
   * @param {Buffer} reply
   * @returns {{ returnCode: number, jobNameBytes: Buffer|null, userIdBytes: Buffer|null }}
   */
  static parseReply(reply) {
    if (!reply || reply.length < 24) {
      throw new DatastreamError('Start server reply too short', {
        bufferOffsets: { start: 0, end: reply?.length ?? 0 },
      });
    }

    const returnCode = reply.readUInt32BE(20);

    let jobNameBytes = null;
    let userIdBytes = null;

    // Search LL/CP area starting at offset 24
    if (reply.length > 24) {
      const jobOffset = ServerStart.#findCodePoint(reply, 24, CP_JOB_NAME);
      if (jobOffset >= 0) {
        const ll = reply.readUInt32BE(jobOffset);
        const dataLen = ll - 10; // LL(4) + CP(2) + CCSID(4)
        if (dataLen > 0 && jobOffset + 10 + dataLen <= reply.length) {
          jobNameBytes = Buffer.alloc(dataLen);
          reply.copy(jobNameBytes, 0, jobOffset + 10, jobOffset + 10 + dataLen);
        }
      }

      const userOffset = ServerStart.#findCodePoint(reply, 24, CP_USER_ID);
      if (userOffset >= 0) {
        const ll = reply.readUInt32BE(userOffset);
        const dataLen = ll - 10;
        if (dataLen > 0 && userOffset + 10 + dataLen <= reply.length) {
          userIdBytes = Buffer.alloc(dataLen);
          reply.copy(userIdBytes, 0, userOffset + 10, userOffset + 10 + dataLen);
        }
      }
    }

    if (returnCode !== 0) {
      throw new AS400SecurityError(`Start server failed with RC=${returnCode}`, {
        returnCode,
      });
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, `Start server reply: RC=${returnCode}`);
    }

    return { returnCode, jobNameBytes, userIdBytes };
  }

  /**
   * Determine the authentication scheme byte value.
   */
  static #authSchemeByte(scheme, authLen) {
    switch (scheme) {
      case AuthScheme.PASSWORD:
        if (authLen === 8)  return 0x01; // DES
        if (authLen === 20) return 0x03; // SHA-1
        return 0x07; // SHA-512
      case AuthScheme.GSS_TOKEN:
        return 0x05;
      case AuthScheme.IDENTITY_TOKEN:
        return 0x06;
      case AuthScheme.PROFILE_TOKEN:
      default:
        return 0x02;
    }
  }

  /**
   * Find a code point in LL/CP chain.
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
