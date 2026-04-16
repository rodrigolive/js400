/**
 * Change-password request/reply workflow.
 *
 * Requires an active signon connection with exchanged attributes (password level,
 * seeds). Encrypts the current password, protects both old and new passwords,
 * and sends the change-password request.
 *
 * Upstream: ChangePasswordReq.java, ChangePasswordRep.java
 * @module auth/change-password
 */

import { Trace } from '../core/Trace.js';
import { Service, ServerID } from '../core/constants.js';
import { AS400SecurityError } from '../core/errors.js';
import { SignonExchangeReq } from './protocol/SignonExchangeReq.js';
import { SignonExchangeRep } from './protocol/SignonExchangeRep.js';
import { ChangePasswordReq } from './protocol/ChangePasswordReq.js';
import { ChangePasswordRep } from './protocol/ChangePasswordRep.js';
import {
  encryptPassword,
  protectPassword,
  stringToEbcdic,
} from './password-encrypt.js';
import { RC } from './constants.js';

/**
 * Change a user's password on the IBM i system.
 *
 * @param {import('../core/AS400.js').AS400} as400
 * @param {string} oldPassword
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
export async function changePassword(as400, oldPassword, newPassword) {
  const signonServerId = ServerID.SIGNON;

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC, `ChangePassword: starting for user=${as400.user}`);
  }

  // Connect to signon service
  const conn = await as400.connectService(Service.SIGNON);

  // Exchange attributes to get password level and seeds
  const { buffer: exchangeReq, clientSeed } = SignonExchangeReq.build({
    serverId: signonServerId,
  });

  const exchangeReplyBuf = await conn.sendAndReceive(exchangeReq);
  const exchangeReply = SignonExchangeRep.parse(exchangeReplyBuf);

  const { passwordLevel, serverSeed, serverLevel } = exchangeReply;

  if (!serverSeed) {
    throw new AS400SecurityError('Server did not provide a seed for change password', {
      returnCode: RC.GENERAL_SECURITY_ERROR,
    });
  }

  // Encrypt the current password for authentication
  const encryptedPw = encryptPassword({
    userId: as400.user,
    password: oldPassword,
    clientSeed,
    serverSeed,
    passwordLevel,
  });

  // Protect old and new passwords
  const protectedOld = protectPassword(oldPassword, clientSeed, serverSeed, passwordLevel);
  const protectedNew = protectPassword(newPassword, clientSeed, serverSeed, passwordLevel);

  const userIdEbcdic = stringToEbcdic(as400.user, true);

  // Build and send change-password request
  const req = ChangePasswordReq.build({
    serverId: signonServerId,
    userIdBytes: userIdEbcdic,
    encryptedPassword: encryptedPw,
    protectedOldPassword: protectedOld,
    protectedNewPassword: protectedNew,
    passwordLevel,
    oldPasswordLength: oldPassword.length,
    newPasswordLength: newPassword.length,
    serverLevel,
  });

  const replyBuf = await conn.sendAndReceive(req);
  ChangePasswordRep.parse(replyBuf);

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC, 'ChangePassword: password changed successfully');
  }
}
