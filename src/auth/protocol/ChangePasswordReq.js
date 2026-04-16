/**
 * Change-password request builder.
 *
 * Upstream: ChangePasswordReq.java
 * @module auth/protocol/ChangePasswordReq
 */

import { Trace } from '../../core/Trace.js';
import { ServerID } from '../../core/constants.js';
import {
  CHANGE_PASSWORD_REQ,
  CP,
  AUTH_BYTES_TYPE,
} from '../constants.js';

export class ChangePasswordReq {

  /**
   * Build a change-password request.
   *
   * @param {object} opts
   * @param {number} opts.serverId
   * @param {Uint8Array} opts.userIdBytes - 10-byte EBCDIC user ID
   * @param {Uint8Array} opts.encryptedPassword - Encrypted current password
   * @param {Uint8Array} opts.protectedOldPassword - Protected old password
   * @param {Uint8Array} opts.protectedNewPassword - Protected new password
   * @param {number} opts.passwordLevel - 0-4
   * @param {number} [opts.oldPasswordLength] - Original length (for SHA levels)
   * @param {number} [opts.newPasswordLength] - Original length (for SHA levels)
   * @param {number} [opts.serverLevel=0] - Server level for optional fields
   * @returns {Buffer}
   */
  static build(opts) {
    const {
      serverId,
      userIdBytes,
      encryptedPassword,
      protectedOldPassword,
      protectedNewPassword,
      passwordLevel,
      oldPasswordLength = 0,
      newPasswordLength = 0,
      serverLevel = 0,
    } = opts;

    const isSHA = encryptedPassword.length !== 8;

    // Determine auth type byte
    let authType;
    if (encryptedPassword.length === 8) authType = AUTH_BYTES_TYPE.DES;
    else if (encryptedPassword.length === 20) authType = AUTH_BYTES_TYPE.SHA1;
    else authType = AUTH_BYTES_TYPE.SHA512;

    // Calculate size
    let size = 20 + 1; // header + template (encryption type byte)
    size += 16; // user ID: LL(4) + CP(2) + 10 bytes
    size += 6 + encryptedPassword.length; // encrypted password
    size += 6 + protectedOldPassword.length; // old password
    size += 6 + protectedNewPassword.length; // new password

    if (isSHA) {
      size += 10; // old password length: LL(4) + CP(2) + uint32
      size += 10; // new password length
      size += 10; // password CCSID
    }

    if (serverLevel >= 5) {
      size += 7; // return error messages: LL(4) + CP(2) + 1 byte
    }

    const buf = Buffer.alloc(size);

    // Header
    buf.writeUInt32BE(size, 0);
    buf.writeUInt16BE(0x0000, 4);
    buf.writeUInt16BE(serverId, 6);
    buf.writeUInt32BE(0, 8);
    buf.writeUInt32BE(0, 12);
    buf.writeUInt16BE(1, 16); // template length = 1
    buf.writeUInt16BE(CHANGE_PASSWORD_REQ, 18);

    // Template: encryption type
    buf[20] = authType;

    let offset = 21;

    // User ID
    buf.writeUInt32BE(16, offset);
    buf.writeUInt16BE(CP.USER_ID, offset + 4);
    Buffer.from(userIdBytes).copy(buf, offset + 6, 0, 10);
    offset += 16;

    // Encrypted password
    buf.writeUInt32BE(6 + encryptedPassword.length, offset);
    buf.writeUInt16BE(CP.PASSWORD, offset + 4);
    Buffer.from(encryptedPassword).copy(buf, offset + 6);
    offset += 6 + encryptedPassword.length;

    // Protected old password
    buf.writeUInt32BE(6 + protectedOldPassword.length, offset);
    buf.writeUInt16BE(CP.OLD_PASSWORD, offset + 4);
    Buffer.from(protectedOldPassword).copy(buf, offset + 6);
    offset += 6 + protectedOldPassword.length;

    // Protected new password
    buf.writeUInt32BE(6 + protectedNewPassword.length, offset);
    buf.writeUInt16BE(CP.NEW_PASSWORD, offset + 4);
    Buffer.from(protectedNewPassword).copy(buf, offset + 6);
    offset += 6 + protectedNewPassword.length;

    if (isSHA) {
      // Old password length
      buf.writeUInt32BE(10, offset);
      buf.writeUInt16BE(CP.OLD_PASSWORD_LEN, offset + 4);
      buf.writeUInt32BE(oldPasswordLength, offset + 6);
      offset += 10;

      // New password length
      buf.writeUInt32BE(10, offset);
      buf.writeUInt16BE(CP.NEW_PASSWORD_LEN, offset + 4);
      buf.writeUInt32BE(newPasswordLength, offset + 6);
      offset += 10;

      // Password CCSID = 13488 (UTF-16)
      buf.writeUInt32BE(10, offset);
      buf.writeUInt16BE(CP.PASSWORD_CCSID, offset + 4);
      buf.writeUInt32BE(13488, offset + 6);
      offset += 10;
    }

    if (serverLevel >= 5) {
      // Return error messages = 0x01
      buf.writeUInt32BE(7, offset);
      buf.writeUInt16BE(CP.RETURN_ERROR_MSGS, offset + 4);
      buf[offset + 6] = 0x01;
      offset += 7;
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, `Built change password request (${size} bytes)`);
    }

    return buf;
  }
}
