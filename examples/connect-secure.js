/**
 * Secure (TLS) connection example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/connect-secure.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/connect-secure.js
 */

import { AS400 } from 'js400';

const host = process.env.JS400_HOST;
const user = process.env.JS400_USER;
const password = process.env.JS400_PASS;

if (!host || !user || !password) {
  console.error('Set JS400_HOST, JS400_USER, and JS400_PASS environment variables.');
  process.exit(1);
}

const system = new AS400({
  host,
  user,
  password,
  secure: true,
  tlsOptions: {
    // For self-signed certificates, uncomment:
    // rejectUnauthorized: false,
  },
});

try {
  await system.signon();

  console.log('Secure connection established.');
  console.log('Job name:', system.getSignonJobName());
} finally {
  await system.close();
}
