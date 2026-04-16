/**
 * Generate authentication token request builder.
 *
 * Upstream: AS400GenAuthTknDS.java, SignonGenAuthTokenRequestDS.java
 * @module auth/protocol/GenAuthTokenReq
 */

import { Trace } from '../../core/Trace.js';
import { ServerID } from '../../core/constants.js';
import {
  GEN_AUTH_TOKEN_REQ,
  CP,
  AUTH_BYTES_TYPE,
  RETURN_TYPE,
} from '../constants.js';

export class GenAuthTokenReq {

  /**
   * Build a generate-authentication-token request.
   *
   * @param {object} opts
   * @param {number} opts.serverId - ServerID.SIGNON
   * @param {Uint8Array} opts.authenticationBytes - Encrypted password or existing token
   * @param {number} opts.authBytesType - AUTH_BYTES_TYPE value
   * @param {number} opts.tokenType - TOKEN_TYPE value (1=single, 2=multi non-renew, 3=multi renew)
   * @param {number} opts.timeoutInterval - Token timeout in seconds
   * @param {Uint8Array} [opts.userIdBytes] - 10-byte EBCDIC user ID (null for token-based)
   * @param {Buffer} [opts.addAuthFactor] - Additional auth factor (UTF-8)
   * @param {Buffer} [opts.verificationId] - Verification ID (UTF-8)
   * @param {Buffer} [opts.clientIPAddr] - Client IP (UTF-8)
   * @returns {Buffer}
   */
  static build(opts) {
    const {
      serverId,
      authenticationBytes,
      authBytesType,
      tokenType,
      timeoutInterval,
      userIdBytes = null,
      addAuthFactor = null,
      verificationId = null,
      clientIPAddr = null,
    } = opts;

    // Calculate size
    let size = 20 + 2; // header + template (authBytesType + returnType)
    size += 7;  // LL(4) + CP(2) + tokenType(1) for CP 0x1116
    size += 10; // LL(4) + CP(2) + timeout(4) for CP 0x1117
    size += 6 + authenticationBytes.length; // LL(4) + CP(2) + auth bytes
    if (userIdBytes) size += 16; // LL(4) + CP(2) + 10 bytes

    if (addAuthFactor?.length > 0) size += 10 + addAuthFactor.length;
    if (verificationId?.length > 0) size += 10 + verificationId.length;
    if (clientIPAddr?.length > 0) size += 10 + clientIPAddr.length;

    const buf = Buffer.alloc(size);

    // Header
    buf.writeUInt32BE(size, 0);
    buf.writeUInt16BE(0x0000, 4);
    buf.writeUInt16BE(serverId, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(2, 16);  // template length = 2
    buf.writeUInt16BE(GEN_AUTH_TOKEN_REQ, 18);

    // Template
    buf[20] = authBytesType;
    buf[21] = RETURN_TYPE.PROFILE_TOKEN;

    let offset = 22;

    // Token type: LL=7, CP=0x1116, 1 byte
    buf.writeUInt32BE(7, offset);
    buf.writeUInt16BE(CP.TOKEN_TYPE, offset + 4);
    buf[offset + 6] = 0xF0 | tokenType;
    offset += 7;

    // Token expiration: LL=10, CP=0x1117, uint32 seconds
    buf.writeUInt32BE(10, offset);
    buf.writeUInt16BE(CP.TOKEN_EXPIRATION, offset + 4);
    buf.writeUInt32BE(timeoutInterval, offset + 6);
    offset += 10;

    // Auth bytes: LL=6+len, CP=0x1105 (password) or 0x1115 (token)
    const authCp = (authBytesType === AUTH_BYTES_TYPE.TOKEN)
      ? CP.AUTH_TOKEN : CP.PASSWORD;
    buf.writeUInt32BE(6 + authenticationBytes.length, offset);
    buf.writeUInt16BE(authCp, offset + 4);
    Buffer.from(authenticationBytes).copy(buf, offset + 6);
    offset += 6 + authenticationBytes.length;

    // User ID
    if (userIdBytes) {
      buf.writeUInt32BE(16, offset);
      buf.writeUInt16BE(CP.USER_ID, offset + 4);
      Buffer.from(userIdBytes).copy(buf, offset + 6, 0, 10);
      offset += 16;
    }

    // Additional auth factor
    if (addAuthFactor?.length > 0) {
      buf.writeUInt32BE(10 + addAuthFactor.length, offset);
      buf.writeUInt16BE(CP.ADD_AUTH_FACTOR, offset + 4);
      buf.writeUInt32BE(1208, offset + 6);
      addAuthFactor.copy(buf, offset + 10);
      offset += 10 + addAuthFactor.length;
    }

    // Verification ID
    if (verificationId?.length > 0) {
      buf.writeUInt32BE(10 + verificationId.length, offset);
      buf.writeUInt16BE(CP.VERIFICATION_ID, offset + 4);
      buf.writeUInt32BE(1208, offset + 6);
      verificationId.copy(buf, offset + 10);
      offset += 10 + verificationId.length;
    }

    // Client IP
    if (clientIPAddr?.length > 0) {
      buf.writeUInt32BE(10 + clientIPAddr.length, offset);
      buf.writeUInt16BE(CP.CLIENT_IP, offset + 4);
      buf.writeUInt32BE(1208, offset + 6);
      clientIPAddr.copy(buf, offset + 10);
      offset += 10 + clientIPAddr.length;
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, `Built gen auth token request (${size} bytes)`);
    }

    return buf;
  }
}
