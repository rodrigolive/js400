/**
 * Service IDs, server IDs, default ports, and service name constants.
 *
 * Upstream: AS400.java, AS400Server.java, PortMapper.java
 * @module core/constants
 */

/** Host server service identifiers (matches JTOpen AS400.java constants). */
export const Service = Object.freeze({
  FILE:         0,  // IFS file server
  PRINT:        1,  // Print / spooled file server
  COMMAND:      2,  // Remote command / program call
  DATAQUEUE:    3,  // Data queue server
  DATABASE:     4,  // Database (SQL) server
  RECORDACCESS: 5,  // Record-level access (DDM)
  CENTRAL:      6,  // Central server (license, NLS)
  SIGNON:       7,  // Sign-on server
  HOSTCNN:      8,  // Host connection server
});

/** Default non-TLS ports (matches PortMapper.java setServicePortsToDefault). */
export const DefaultPort = Object.freeze({
  [Service.FILE]:         8473,
  [Service.PRINT]:        8474,
  [Service.COMMAND]:      8475,
  [Service.DATAQUEUE]:    8472,
  [Service.DATABASE]:     8471,
  [Service.RECORDACCESS]: 446,
  [Service.CENTRAL]:      8470,
  [Service.SIGNON]:       8476,
  [Service.HOSTCNN]:      0,
});

/** Default TLS ports (matches PortMapper.java setServicePortsToDefault). */
export const DefaultSecurePort = Object.freeze({
  [Service.FILE]:         9473,
  [Service.PRINT]:        9474,
  [Service.COMMAND]:      9475,
  [Service.DATAQUEUE]:    9472,
  [Service.DATABASE]:     9471,
  [Service.RECORDACCESS]: 448,
  [Service.CENTRAL]:      9470,
  [Service.SIGNON]:       9476,
  [Service.HOSTCNN]:      9480,
});

/**
 * Server IDs used in the datastream header at offset 6.
 * Derived from AS400Server.getServerId() in JTOpen.
 */
export const ServerID = Object.freeze({
  CENTRAL:      0xE000,
  FILE:         0xE002,
  PRINT:        0xE003,
  DATABASE:     0xE004,
  DATABASE_NDB: 0xE005,
  DATABASE_ROI: 0xE006,
  DATAQUEUE:    0xE007,
  COMMAND:      0xE008,
  SIGNON:       0xE009,
  HOSTCNN:      0xE00B,
});

/**
 * Map from Service enum value to its ServerID for the datastream header.
 */
export const ServiceToServerID = Object.freeze({
  [Service.FILE]:         ServerID.FILE,
  [Service.PRINT]:        ServerID.PRINT,
  [Service.COMMAND]:      ServerID.COMMAND,
  [Service.DATAQUEUE]:    ServerID.DATAQUEUE,
  [Service.DATABASE]:     ServerID.DATABASE,
  [Service.RECORDACCESS]: 0,  // DDM uses its own framing
  [Service.CENTRAL]:      ServerID.CENTRAL,
  [Service.SIGNON]:       ServerID.SIGNON,
  [Service.HOSTCNN]:      ServerID.HOSTCNN,
});

/**
 * Service name strings used by the port mapper (AS400.getServerName).
 */
export const ServiceName = Object.freeze({
  [Service.FILE]:         'as-file',
  [Service.PRINT]:        'as-netprt',
  [Service.COMMAND]:      'as-rmtcmd',
  [Service.DATAQUEUE]:    'as-dtaq',
  [Service.DATABASE]:     'as-database',
  [Service.RECORDACCESS]: 'as-ddm',
  [Service.CENTRAL]:      'as-central',
  [Service.SIGNON]:       'as-signon',
  [Service.HOSTCNN]:      'as-hostcnn',
});

/** Port mapper port (always 449). */
export const PORT_MAPPER_PORT = 449;

/** Sentinel indicating port mapper should be consulted. */
export const USE_PORT_MAPPER = -1;

/** Seed exchange request/reply ID. */
export const EXCHANGE_SEED_REQ = 0x7001;

/** Start server request/reply ID. */
export const START_SERVER_REQ = 0x7002;

/** Seed exchange reply hash code. */
export const EXCHANGE_SEED_REP = 0xF001;

/** Start server reply hash code. */
export const START_SERVER_REP = 0xF002;

/**
 * Authentication scheme constants (matches AS400.java).
 */
export const AuthScheme = Object.freeze({
  PASSWORD:       0,
  GSS_TOKEN:      1,
  PROFILE_TOKEN:  2,
  IDENTITY_TOKEN: 3,
});
