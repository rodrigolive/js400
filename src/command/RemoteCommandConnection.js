/**
 * Command server connection lifecycle.
 *
 * Handles the seed-exchange → server-start → exchange-attributes
 * handshake for the remote command / program call server (service 2).
 *
 * Upstream: RemoteCommandImplRemote.java (open, exchangeAttributes)
 * @module command/RemoteCommandConnection
 */

import { Service, ServerID } from '../core/constants.js';
import { Trace } from '../core/Trace.js';
import { SeedExchange } from '../transport/SeedExchange.js';
import { ServerStart } from '../transport/ServerStart.js';
import { encryptPassword, stringToEbcdic } from '../auth/password-encrypt.js';
import { CommandReq } from './protocol/CommandReq.js';
import { CommandRep } from './protocol/CommandRep.js';

/** Symbol to attach command server state to the AS400 instance. */
const CMD_STATE = Symbol.for('js400.commandState');

/**
 * @typedef {object} CommandServerState
 * @property {number} datastreamLevel
 * @property {number} ccsid
 * @property {import('../transport/Connection.js').Connection} connection
 */

/**
 * Ensure the command server connection is established and attributes exchanged.
 *
 * @param {import('../core/AS400.js').AS400} system
 * @returns {Promise<CommandServerState>}
 */
export async function ensureCommandConnection(system) {
  // Return cached state if valid
  const existing = system[CMD_STATE];
  if (existing && existing.connection && existing.connection.connected) {
    return existing;
  }

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC, 'RemoteCommandConnection: opening command server');
  }

  // Step 1: Connect to command service
  const conn = await system.connectService(Service.COMMAND);

  // Step 2: Seed exchange
  const { buffer: seedReq, clientSeed } = SeedExchange.buildRequest(ServerID.COMMAND);
  const seedReplyBuf = await conn.sendAndReceive(seedReq);
  const seedReply = SeedExchange.parseReply(seedReplyBuf);

  // Step 3: Server start (authenticate)
  const encryptedPw = encryptPassword({
    userId: system.user,
    password: system.password,
    clientSeed,
    serverSeed: seedReply.serverSeed,
    passwordLevel: system.getPasswordLevel(),
  });

  const userIdEbcdic = stringToEbcdic(system.user, true);
  const startReq = ServerStart.buildRequest({
    serverId: ServerID.COMMAND,
    authenticationBytes: Buffer.from(encryptedPw),
    userIdBytes: Buffer.from(userIdEbcdic),
    authScheme: 0,
  });

  const startReplyBuf = await conn.sendAndReceive(startReq);
  ServerStart.parseReply(startReplyBuf);

  // Step 4: Exchange attributes
  const exchBuf = CommandReq.buildExchangeAttributes({
    ccsid: system.getServerCCSID() || 0,
  });
  const exchReplyBuf = await conn.sendAndReceive(exchBuf);
  const exchReply = CommandRep.parseExchangeAttributes(exchReplyBuf);

  const state = {
    datastreamLevel: exchReply.datastreamLevel,
    ccsid: exchReply.ccsid || 37,
    connection: conn,
  };

  system[CMD_STATE] = state;

  if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
    Trace.log(Trace.DIAGNOSTIC,
      `RemoteCommandConnection: ready, datastreamLevel=${state.datastreamLevel}, ccsid=${state.ccsid}`);
  }

  return state;
}

/**
 * Clear cached command connection state.
 * @param {import('../core/AS400.js').AS400} system
 */
export function clearCommandState(system) {
  delete system[CMD_STATE];
}
