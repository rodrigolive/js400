/**
 * DDM connection pool and connection lifecycle management.
 *
 * Manages DDM connections to the record-level access server.
 * Handles the DDM-specific authentication flow (EXCSAT → ACCSEC → SECCHK)
 * which is separate from the Client Access signon used by other services.
 *
 * Upstream: CADSPool.java, DDMRecordCache.java
 * @module record/protocol/DDMPool
 */

import { Connection } from '../../transport/Connection.js';
import { Service, DefaultPort, DefaultSecurePort } from '../../core/constants.js';
import { AS400Error } from '../../core/errors.js';
import { DDMReq } from './DDMReq.js';
import { DDMRep } from './DDMRep.js';

/** Symbol to store DDM connection state on an AS400 instance. */
const DDM_STATE = Symbol('ddm.state');

export class DDMPool {

  /**
   * Ensure a DDM connection is established and authenticated.
   * Returns the connection ready for file operations.
   *
   * @param {import('../../core/AS400.js').AS400} system
   * @returns {Promise<Connection>}
   */
  static async ensureConnection(system) {
    if (system[DDM_STATE]?.connection?.connected) {
      return system[DDM_STATE].connection;
    }

    const secure = system.secure ?? false;
    const port = system.getServicePort?.(Service.RECORDACCESS)
      ?? (secure ? DefaultSecurePort[Service.RECORDACCESS] : DefaultPort[Service.RECORDACCESS]);

    const conn = new Connection({
      host: system.host,
      port,
      serviceId: Service.RECORDACCESS,
      secure,
      tlsOptions: system.tlsOptions,
    });

    await conn.connect();

    // DDM authentication flow: EXCSAT → ACCSEC → SECCHK
    // 1. Exchange server attributes
    const excsatReq = DDMReq.buildExchangeAttributes();
    await conn.send(excsatReq);
    const excsatReply = await DDMRep.readFrame(conn._getSocket?.() ?? conn);

    // 2. Access security
    const accsecReq = DDMReq.buildAccessSecurity({
      securityMechanism: 3, // user ID + password (cleartext for DDM)
      rdbName: system.host,
    });
    await conn.send(accsecReq);
    const accsecReply = await DDMRep.readFrame(conn._getSocket?.() ?? conn);

    // 3. Security check
    const passwordBytes = Buffer.from(system.password ?? '', 'utf-8');
    const secchkReq = DDMReq.buildSecurityCheck({
      securityMechanism: 3,
      userId: system.user ?? '',
      password: passwordBytes,
    });
    await conn.send(secchkReq);
    const secchkReply = await DDMRep.readFrame(conn._getSocket?.() ?? conn);

    system[DDM_STATE] = { connection: conn };
    return conn;
  }

  /**
   * Close the DDM connection for a system.
   * @param {import('../../core/AS400.js').AS400} system
   */
  static close(system) {
    if (system[DDM_STATE]?.connection) {
      system[DDM_STATE].connection.close();
      system[DDM_STATE] = null;
    }
  }
}
