/**
 * Authentication indicator enums, password levels, code points,
 * return codes, and token type constants.
 *
 * Upstream: AuthenticationIndicator.java, AS400.java, AS400GenAuthTknDS.java
 * @module auth/constants
 */

export const AUTHENTICATION_INDICATOR = Object.freeze({
  PASSWORD: 'PASSWORD',
  PROFILE_TOKEN: 'PROFILE_TOKEN',
});

export const PASSWORD_LEVEL = Object.freeze({
  LEVEL_0: 0,
  LEVEL_1: 1,
  LEVEL_2: 2,
  LEVEL_3: 3,
  LEVEL_4: 4,
});

/** Signon exchange attributes request/reply IDs. */
export const SIGNON_EXCHANGE_ATTR_REQ = 0x7003;
export const SIGNON_EXCHANGE_ATTR_REP = 0xF003;
export const HOSTCNN_EXCHANGE_ATTR_REQ = 0x7103;

/** Change password request/reply IDs. */
export const CHANGE_PASSWORD_REQ = 0x7004;
export const CHANGE_PASSWORD_REP = 0xF004;

/** Generate auth token request/reply IDs. */
export const GEN_AUTH_TOKEN_REQ = 0x7005;
export const GEN_AUTH_TOKEN_REP = 0xF005;

/** Code points used in signon/auth datastreams. */
export const CP = Object.freeze({
  CLIENT_VERSION:      0x1101,
  CLIENT_LEVEL:        0x1102,
  CLIENT_SEED:         0x1103,
  USER_ID:             0x1104,
  PASSWORD:            0x1105,
  AUTH_TOKEN:          0x1115,
  TOKEN_TYPE:          0x1116,
  TOKEN_EXPIRATION:    0x1117,
  PASSWORD_LEVEL:      0x1119,
  OLD_PASSWORD:        0x110C,
  NEW_PASSWORD:        0x110D,
  OLD_PASSWORD_LEN:    0x111C,
  NEW_PASSWORD_LEN:    0x111D,
  PASSWORD_CCSID:      0x111E,
  JOB_NAME:            0x111F,
  USER_IDENTITY_TYPE:  0x1126,
  USER_IDENTITY:       0x1127,
  RETURN_ERROR_MSGS:   0x1128,
  AAF_INDICATOR:       0x112E,
  ADD_AUTH_FACTOR:     0x112F,
  VERIFICATION_ID:     0x1130,
  CLIENT_IP:           0x1131,
});

/** Profile token type values (sent in CP 0x1116). */
export const TOKEN_TYPE = Object.freeze({
  SINGLE_USE:               0x01,
  MULTIPLE_USE_NON_RENEWABLE: 0x02,
  MULTIPLE_USE_RENEWABLE:   0x03,
});

/** Auth scheme byte values (used in start server / gen token requests). */
export const AUTH_BYTES_TYPE = Object.freeze({
  DES:      0x01,
  SHA1:     0x03,
  SHA512:   0x07,
  GSS:      0x05,
  IDENTITY: 0x06,
  TOKEN:    0x02,
});

/** Return type byte values (gen auth token request). */
export const RETURN_TYPE = Object.freeze({
  PROFILE_TOKEN: 0x01,
});

/** Well-known signon return codes from AS400SecurityException.java. */
export const RC = Object.freeze({
  SUCCESS:                 0x00000000,
  PASSWORD_EXPIRED:        0x00020001,
  PASSWORD_OLD_NOT_VALID:  0x00030001,
  PASSWORD_NEW_TOO_LONG:   0x00030002,
  PASSWORD_NEW_TOO_SHORT:  0x00030003,
  PASSWORD_NEW_REPEAT:     0x00030004,
  PASSWORD_NEW_ADJACENT:   0x00030005,
  PASSWORD_NEW_TOO_SIMPLE: 0x00030006,
  PASSWORD_NEW_CHAR_NOT_VALID: 0x00030007,
  PASSWORD_NEW_DISALLOWED: 0x00030008,
  PASSWORD_NEW_SAME_POS:   0x00030009,
  PASSWORD_NEW_NO_NUMERIC: 0x0003000A,
  PASSWORD_NEW_VALIDATION_PGM: 0x0003000B,
  USERID_UNKNOWN:          0x00010001,
  USERID_DISABLE:          0x00010002,
  USERID_MISMATCH:         0x00010003,
  PASSWORD_INCORRECT:      0x0001000B,
  PASSWORD_ERROR:          0x0001000C,
  PASSWORD_CHANGE_REQUIRED: 0x0001000D,
  TOKEN_NOT_VALID:         0x0001000E,
  GENERAL_SECURITY_ERROR:  0x00040000,
});

/** Signon EBCDIC blank for padding. */
export const EBCDIC_BLANK = 0x40;
