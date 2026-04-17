/**
 * Program call example using the high-level callProgram() API.
 *
 * Calls QUSRTVUS (Retrieve User Space) as a demonstration,
 * but you can replace with any program on your system.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/program-call.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/program-call.js
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

  // Example: call a simple program that echoes its input.
  // Replace with your own program path and parameters.
  const result = await system.callProgram({
    program: '/QSYS.LIB/QSYS.LIB/QUSCMDLN.PGM',
    parameters: [
      { type: 'char', length: 10, value: 'HELLO', usage: 'input' },
    ],
  });

  console.log('Success:', result.success);
  for (const msg of result.messages) {
    console.log(`  ${msg.id}: ${msg.text}`);
  }
} finally {
  await system.close();
}
