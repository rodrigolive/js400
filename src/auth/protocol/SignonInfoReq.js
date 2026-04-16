/**
 * Signon info request builder.
 *
 * Sends user credentials (user ID + encrypted password) to the signon server
 * for authentication. Uses request ID 0x7004, which is shared with the
 * change-password request but distinguished by the code points present.
 *
 * Request layout:
 *   0-19   Standard 20-byte header (reqRepId = 0x7004)
 *   20     Auth scheme byte (template, 1 byte)
 *   21+    LL/CP pairs:
 *          - CP 0x1104: User ID (10 bytes EBCDIC)
 *          - CP 0x1105: Encrypted password
 *          - CP 0x1128: Return error messages (1 byte, optional)
 *
 * Upstream: SignonInfoReq.java, AS400ImplRemote.java
 * @module auth/protocol/SignonInfoReq
 */

import { Trace } from '../../core/Trace.js';
import { ServerID } from '../../core/constants.js';
import {
  CHANGE_PASSWORD_REQ as SIGNON_INFO_REQ,
  CP,
  AUTH_BYTES_TYPE,
} from '../constants.js';

export class SignonInfoReq {

  /**
   * Build a signon info request.
   *
   * @param {object} opts
   * @param {number} opts.serverId - ServerID.SIGNON (0xE009)
   * @param {Uint8Array} opts.userIdBytes - 10-byte EBCDIC user ID
   * @param {Uint8Array} opts.encryptedPassword - Encrypted password bytes
   * @param {number} [opts.serverLevel=0] - Server level from exchange attributes
   * @returns {Buffer}
   */
  static build(opts) {
    const {
      serverId,
      userIdBytes,
      encryptedPassword,
      serverLevel = 0,
    } = opts;

    // Determine auth type byte from encrypted password length
    let authType;
    if (encryptedPassword.length === 8) authType = AUTH_BYTES_TYPE.DES;
    else if (encryptedPassword.length === 20) authType = AUTH_BYTES_TYPE.SHA1;
    else authType = AUTH_BYTES_TYPE.SHA512;

    // Calculate size
    let size = 20 + 1; // header + template (auth scheme byte)
    size += 16; // user ID: LL(4) + CP(2) + 10 bytes
    size += 6 + encryptedPassword.length; // password: LL(4) + CP(2) + data

    if (serverLevel >= 5) {
      size += 7; // return error messages: LL(4) + CP(2) + 1 byte
    }

    const buf = Buffer.alloc(size);

    // Header (20 bytes)
    buf.writeUInt32BE(size, 0);
    buf.writeUInt16BE(0x0000, 4);    // client/server attributes
    buf.writeUInt16BE(serverId, 6);
    buf.writeUInt32BE(0, 8);         // csInstance
    buf.writeUInt32BE(0, 12);        // correlation
    buf.writeUInt16BE(1, 16);        // template length = 1
    buf.writeUInt16BE(SIGNON_INFO_REQ, 18);

    // Template: authentication scheme byte
    buf[20] = authType;

    let offset = 21;

    // User ID: LL=16, CP=0x1104, data=10 bytes EBCDIC
    buf.writeUInt32BE(16, offset);
    buf.writeUInt16BE(CP.USER_ID, offset + 4);
    Buffer.from(userIdBytes).copy(buf, offset + 6, 0, 10);
    offset += 16;

    // Encrypted password: LL=6+n, CP=0x1105, data=encrypted bytes
    buf.writeUInt32BE(6 + encryptedPassword.length, offset);
    buf.writeUInt16BE(CP.PASSWORD, offset + 4);
    Buffer.from(encryptedPassword).copy(buf, offset + 6);
    offset += 6 + encryptedPassword.length;

    // Return error messages (optional, for server level >= 5)
    if (serverLevel >= 5) {
      buf.writeUInt32BE(7, offset);
      buf.writeUInt16BE(CP.RETURN_ERROR_MSGS, offset + 4);
      buf[offset + 6] = 0x01;
      offset += 7;
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, `Built signon info request (${size} bytes, authType=0x${authType.toString(16)})`);
    }

    return buf;
  }
}
