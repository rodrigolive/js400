/**
 * CL command call example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/command-call.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/command-call.js
 */

import { AS400, CommandCall } from 'js400';

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

  // Run a CL command using the convenience method
  const messages = await system.runCommand('DSPLIB LIB(QGPL)');
  console.log('runCommand messages:');
  for (const msg of messages) {
    console.log(`  ${msg.id}: ${msg.text}`);
  }

  // Or use CommandCall directly for more control
  const cmd = new CommandCall(system);
  const success = await cmd.run('RTVJOBA');
  console.log('\nCommandCall success:', success);
  for (const msg of cmd.getMessageList()) {
    console.log(`  ${msg.id} (sev ${msg.severity}): ${msg.text}`);
  }
} finally {
  await system.close();
}
