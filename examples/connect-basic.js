/**
 * Basic connection example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/connect-basic.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/connect-basic.js
 */

import { AS400 } from 'js400';

const host = process.env.JS400_HOST;
const user = process.env.JS400_USER;
const password = process.env.JS400_PASS;

if (!host || !user || !password) {
  console.error('Set JS400_HOST, JS400_USER, and JS400_PASS environment variables.');
  process.exit(1);
}

const system = new AS400({ host, user, password });

try {
  await system.signon();

  const info = system.getServerInfo();
  console.log('Signed on successfully.');
  console.log('Job name:', info.jobName);
  console.log('Server version:', info.serverVersion.toString(16));
  console.log('Password level:', info.passwordLevel);
  console.log('Server CCSID:', info.serverCCSID);
} finally {
  await system.close();
}
