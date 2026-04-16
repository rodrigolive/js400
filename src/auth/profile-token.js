/**
 * Profile token generation and reuse helpers.
 *
 * Supports generating a profile token from an authenticated session,
 * and using a profile token for subsequent sign-on.
 *
 * Upstream: ProfileTokenCredential.java, AS400GenAuthTkn*.java
 * @module auth/profile-token
 */

import { Trace } from '../core/Trace.js';
import { Service, ServerID } from '../core/constants.js';
import { AS400SecurityError } from '../core/errors.js';
import { SeedExchange } from '../transport/SeedExchange.js';
import { ServerStart } from '../transport/ServerStart.js';
import { SignonExchangeReq } from './protocol/SignonExchangeReq.js';
import { SignonExchangeRep } from './protocol/SignonExchangeRep.js';
import { GenAuthTokenReq } from './protocol/GenAuthTokenReq.js';
import { GenAuthTokenRep } from './protocol/GenAuthTokenRep.js';
import {
  encryptPassword,
  stringToEbcdic,
} from './password-encrypt.js';
import {
  TOKEN_TYPE,
  AUTH_BYTES_TYPE,
  RC,
} from './constants.js';

/**
 * A profile token returned by the IBM i signon server.
 */
export class ProfileToken {
  /** @type {Buffer} 32-byte token */
  #token;
  /** @type {number} token type */
  #type;
  /** @type {number} timeout interval in seconds */
  #timeoutInterval;

  /**
   * @param {Buffer} token - 32-byte token
   * @param {number} type - Token type constant
   * @param {number} timeoutInterval - Seconds
   */
  constructor(token, type, timeoutInterval) {
    this.#token = token;
    this.#type = type;
    this.#timeoutInterval = timeoutInterval;
  }

  get token() { return this.#token; }
  get type() { return this.#type; }
  get timeoutInterval() { return this.#timeoutInterval; }

  /** Token bytes as Uint8Array. */
  get bytes() { return new Uint8Array(this.#token); }
}

/** Map user-facing token type strings to constants. */
const TOKEN_TYPE_MAP = {
  singleUse: TOKEN_TYPE.SINGLE_USE,
  multipleUseNonRenewable: TOKEN_TYPE.MULTIPLE_USE_NON_RENEWABLE,
  multipleUseRenewable: TOKEN_TYPE.MULTIPLE_USE_RENEWABLE,
};

/**
 * Generate a profile token from an authenticated session.
 *
 * @param {import('../core/AS400.js').AS400} as400
 * @param {object} opts
 * @param {string} [opts.tokenType='multipleUseRenewable']
 * @param {number} [opts.timeoutInterval=3600]
 * @returns {Promise<ProfileToken>}
 */
export async function generateProfileToken(as400, opts = {}) {
  const tokenType = TOKEN_TYPE_MAP[opts.tokenType] ?? TOKEN_TYPE.MULTIPLE_USE_RENEWABLE;
  const timeoutInterval = opts.timeoutInterval ?? 3600;
  const signonServerId = ServerID.SIGNON;

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC, `ProfileToken: generating for user=${as400.user}`);
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
    throw new AS400SecurityError('Server did not provide a seed for token generation', {
      returnCode: RC.GENERAL_SECURITY_ERROR,
    });
  }

  // Encrypt the password
  const encryptedPw = encryptPassword({
    userId: as400.user,
    password: as400.password,
    clientSeed,
    serverSeed,
    passwordLevel,
  });

  // Determine auth bytes type
  let authBytesType;
  if (encryptedPw.length === 8) authBytesType = AUTH_BYTES_TYPE.DES;
  else if (encryptedPw.length === 20) authBytesType = AUTH_BYTES_TYPE.SHA1;
  else authBytesType = AUTH_BYTES_TYPE.SHA512;

  const userIdEbcdic = stringToEbcdic(as400.user, true);

  // Build and send generate auth token request
  const req = GenAuthTokenReq.build({
    serverId: signonServerId,
    authenticationBytes: encryptedPw,
    authBytesType,
    tokenType,
    timeoutInterval,
    userIdBytes: userIdEbcdic,
  });

  const replyBuf = await conn.sendAndReceive(req);
  const reply = GenAuthTokenRep.parse(replyBuf);

  if (!reply.profileToken) {
    throw new AS400SecurityError('Server did not return a profile token', {
      returnCode: RC.TOKEN_NOT_VALID,
    });
  }

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC, 'ProfileToken: generated successfully');
  }

  return new ProfileToken(reply.profileToken, tokenType, timeoutInterval);
}

/**
 * Perform signon using a profile token instead of a password.
 *
 * @param {import('../core/AS400.js').AS400} as400
 * @param {ProfileToken} profileToken
 * @returns {Promise<{
 *   serverVersion: number,
 *   serverLevel: number,
 *   passwordLevel: number,
 *   jobName: string,
 * }>}
 */
export async function signonWithToken(as400, profileToken) {
  const signonServerId = ServerID.SIGNON;

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC, 'ProfileToken: signing on with token');
  }

  const conn = await as400.connectService(Service.SIGNON);

  // Exchange attributes
  const { buffer: exchangeReq, clientSeed } = SignonExchangeReq.build({
    serverId: signonServerId,
  });
  const exchangeReplyBuf = await conn.sendAndReceive(exchangeReq);
  const exchangeReply = SignonExchangeRep.parse(exchangeReplyBuf);

  const { serverVersion, serverLevel, passwordLevel, jobNameBytes: exchangeJobName } = exchangeReply;

  // Seed exchange for start server
  const { buffer: seedReq } = SeedExchange.buildRequest(signonServerId);
  const seedReplyBuf = await conn.sendAndReceive(seedReq);
  SeedExchange.parseReply(seedReplyBuf);

  // Start server with profile token
  const startReq = ServerStart.buildRequest({
    serverId: signonServerId,
    authenticationBytes: profileToken.token,
    authScheme: 2, // AuthScheme.PROFILE_TOKEN
  });

  const startReplyBuf = await conn.sendAndReceive(startReq);
  const startReply = ServerStart.parseReply(startReplyBuf);

  let jobName = '';
  if (startReply.jobNameBytes) {
    jobName = startReply.jobNameBytes.toString('utf-8').trim();
  } else if (exchangeJobName) {
    jobName = exchangeJobName.toString('utf-8').trim();
  }

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC, `ProfileToken: authenticated with token, jobName=${jobName}`);
  }

  return {
    serverVersion,
    serverLevel,
    passwordLevel,
    jobName,
  };
}
