# Authentication

js400 authenticates against the IBM i signon host server using the same wire protocol as JTOpen. It supports password-based authentication at all password levels (0-4), profile tokens, TLS, and password change flows.

## Password authentication

```js
import { AS400 } from 'js400';

const system = new AS400({
  host: 'ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
});

await system.signon();
console.log('Password level:', system.getPasswordLevel());
console.log('Server CCSID:', system.getServerCCSID());
```

The signon flow automatically handles the password level negotiated by the server:

| Level | Encryption | Notes |
| --- | --- | --- |
| 0-1 | DES | Legacy, uses EBCDIC-encoded password with DES |
| 2-3 | SHA-1 | Uses SHA-1 password substitution |
| 4 | SHA-512 | Most secure password level, uses SHA-512 |

js400 selects the correct algorithm automatically based on the server's response during the signon exchange.

## TLS (secure connections)

```js
const system = new AS400({
  host: 'ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
  secure: true,
});
```

When `secure: true` is set, all connections use TLS. This encrypts the entire data stream, not just the authentication exchange.

For self-signed certificates:

```js
const system = new AS400({
  host: 'ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
  secure: true,
  tlsOptions: { rejectUnauthorized: false },
});
```

You can also supply a CA certificate:

```js
import { readFileSync } from 'node:fs';

const system = new AS400({
  host: 'ibmi-host',
  user: 'MYUSER',
  password: 'mypassword',
  secure: true,
  tlsOptions: {
    ca: readFileSync('/path/to/ca-cert.pem'),
  },
});
```

## Profile tokens

Profile tokens allow authentication without storing or transmitting the password after the initial signon.

### Generate a token

```js
const system = new AS400({ host, user, password });
await system.signon();

const token = await system.generateProfileToken({
  tokenType: 'multipleUseRenewable', // or 'singleUse', 'multipleUseNonRenewable'
  timeoutInterval: 3600, // seconds
});

console.log('Token bytes:', token.token);
console.log('Expires:', token.expirationTimestamp);
```

### Authenticate with a token

```js
const system2 = new AS400({ host, user: 'MYUSER' });
system2.setProfileToken(token);
await system2.signon();
```

### Token types

| Type | Reuse | Renewable |
| --- | --- | --- |
| `singleUse` | One authentication only | No |
| `multipleUseNonRenewable` | Reusable until expiry | No |
| `multipleUseRenewable` | Reusable and renewable | Yes |

## Change password

```js
const system = new AS400({ host, user, password: currentPassword });
await system.changePassword(currentPassword, newPassword);
```

## Signon handler (expired password)

You can set a callback to handle expired passwords during signon:

```js
const system = new AS400({
  host: 'ibmi-host',
  user: 'MYUSER',
  password: 'oldpassword',
  signonHandler: async (info) => {
    if (info.passwordExpired) {
      return { newPassword: 'newSecurePassword123' };
    }
    throw info.error;
  },
});

await system.signon();
```

## Constructor options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | `''` | IBM i hostname or IP |
| `user` | `string` | `''` | User profile |
| `password` | `string` | `''` | Password |
| `secure` | `boolean` | `false` | Use TLS for all connections |
| `tlsOptions` | `object` | `{}` | Node.js TLS options passed to `tls.connect()` |
| `timeout` | `number` | `30000` | Connection timeout in milliseconds |
| `abortSignal` | `AbortSignal` | `null` | Cancellation signal |
| `trace` | `boolean` | `false` | Enable tracing on construction |
| `ports` | `object` | `{}` | Per-service port overrides |
| `signonHandler` | `Function` | `null` | Callback for signon events |

## Server info after signon

```js
const info = system.getServerInfo();
// {
//   serverVersion: 0x00070500,
//   serverLevel: 18,
//   passwordLevel: 4,
//   serverCCSID: 37,
//   jobName: '123456/MYUSER/QZDASOINIT',
// }
```

Source: [`src/core/AS400.js`](../src/core/AS400.js), [`src/auth/signon.js`](../src/auth/signon.js), [`src/auth/profile-token.js`](../src/auth/profile-token.js), [`src/auth/change-password.js`](../src/auth/change-password.js)
