/**
 * Sign-on flow orchestrator.
 *
 * Performs the complete authentication handshake:
 *   1. Connect to signon service
 *   2. Exchange attributes (get password level, server seed, server version)
 *   3. Encrypt password using appropriate algorithm
 *   4. Start server (send encrypted password + user ID)
 *   5. Parse reply (job name, return code)
 *   6. Store session state on the AS400 instance
 *
 * Upstream: SignonExchangeAttribute*.java, SignonInfo*.java, AS400ImplRemote.java
 * @module auth/signon
 */

import { Trace } from '../core/Trace.js';
import { Service, ServerID, ServiceToServerID } from '../core/constants.js';
import { AS400SecurityError } from '../core/errors.js';
import { SignonExchangeReq } from './protocol/SignonExchangeReq.js';
import { SignonExchangeRep } from './protocol/SignonExchangeRep.js';
import { SignonInfoReq } from './protocol/SignonInfoReq.js';
import { SignonInfoRep } from './protocol/SignonInfoRep.js';
import { encryptPassword, stringToEbcdic, ebcdicToString } from './password-encrypt.js';
import { CharConverter } from '../ccsid/CharConverter.js';
import { RC, AUTH_BYTES_TYPE } from './constants.js';

/**
 * Perform full sign-on flow against the signon service.
 *
 * @param {import('../core/AS400.js').AS400} as400 - AS400 session instance
 * @returns {Promise<{
 *   serverVersion: number,
 *   serverLevel: number,
 *   passwordLevel: number,
 *   serverCCSID: number,
 *   jobName: string,
 * }>}
 */
export async function signon(as400) {
  const signonServerId = ServerID.SIGNON;

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC, `Signon: starting authentication for user=${as400.user} on ${as400.host}`);
  }

  // Step 1: Connect to signon service
  const conn = await as400.connectService(Service.SIGNON);

  // Step 2: Exchange attributes
  const { buffer: exchangeReq, clientSeed } = SignonExchangeReq.build({
    serverId: signonServerId,
  });

  const exchangeReplyBuf = await conn.sendAndReceive(exchangeReq);
  const exchangeReply = SignonExchangeRep.parse(exchangeReplyBuf);

  const {
    serverVersion,
    serverLevel,
    passwordLevel,
    serverSeed,
    jobNameBytes: exchangeJobName,
  } = exchangeReply;

  if (!serverSeed) {
    throw new AS400SecurityError('Server did not provide a seed', {
      returnCode: RC.GENERAL_SECURITY_ERROR,
    });
  }

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC,
      `Signon: serverVersion=${serverVersion}, serverLevel=${serverLevel}, passwordLevel=${passwordLevel}`);
  }

  // Step 3: Encrypt password
  const encryptedPw = encryptPassword({
    userId: as400.user,
    password: as400.password,
    clientSeed,
    serverSeed,
    passwordLevel,
  });

  // Step 4: Send signon info request (0x7004)
  // The signon service uses its own protocol: exchange attributes (0x7003) for
  // seeds, then signon info (0x7004) for credentials. NOT the generic
  // SeedExchange (0x7001) / StartServer (0x7002) used by other services.
  const userIdEbcdic = stringToEbcdic(as400.user, true);
  const infoReq = SignonInfoReq.build({
    serverId: signonServerId,
    userIdBytes: Buffer.from(userIdEbcdic),
    encryptedPassword: Buffer.from(encryptedPw),
    serverLevel,
  });

  const infoReplyBuf = await conn.sendAndReceive(infoReq);
  const infoReply = SignonInfoRep.parse(infoReplyBuf);

  // Step 5: Extract job name and server CCSID
  // Job name bytes are EBCDIC (CCSID 37) — the CCSID prefix in the CP is always 0.
  let jobName = '';
  const jobBytes = infoReply.jobNameBytes || exchangeJobName;
  if (jobBytes) {
    try {
      jobName = CharConverter.byteArrayToString(jobBytes, 0, jobBytes.length, 37).trim();
    } catch {
      // Fallback: use the signon-converter EBCDIC map
      jobName = ebcdicToString(jobBytes);
    }
  }

  const serverCCSID = infoReply.serverCCSID || 0;

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC, `Signon: authenticated, jobName=${jobName}, serverCCSID=${serverCCSID}`);
  }

  return {
    serverVersion,
    serverLevel,
    passwordLevel,
    serverCCSID,
    jobName,
  };
}

/**
 * Describe a signon return code as a human-readable string.
 *
 * @param {number} rc
 * @returns {string}
 */
export function describeReturnCode(rc) {
  for (const [name, value] of Object.entries(RC)) {
    if (value === rc) return name;
  }
  return `UNKNOWN (0x${rc.toString(16)})`;
}
