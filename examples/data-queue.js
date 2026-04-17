/**
 * Data queue read/write example.
 *
 * Requires a data queue to exist: CRTDTAQ DTAQ(JS400TEST/TESTDQ) MAXLEN(256)
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/data-queue.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/data-queue.js
 */

import { AS400, DataQueue } from 'js400';

const host = process.env.JS400_HOST;
const user = process.env.JS400_USER;
const password = process.env.JS400_PASS;
const lib = process.env.JS400_LIB || 'JS400TEST';

if (!host || !user || !password) {
  console.error('Set JS400_HOST, JS400_USER, and JS400_PASS environment variables.');
  process.exit(1);
}

const system = new AS400({ host, user, password });

try {
  await system.signon();

  const dq = new DataQueue(system, `/QSYS.LIB/${lib}.LIB/TESTDQ.DTAQ`);

  // Write an entry
  const message = `Hello from js400 at ${new Date().toISOString()}`;
  await dq.write(message);
  console.log('Wrote:', message);

  // Read the entry (wait up to 5 seconds)
  const entry = await dq.read(5);
  if (entry) {
    console.log('Read:', entry.data.toString().trim());
  } else {
    console.log('No data available.');
  }

  // Get queue attributes
  const attrs = await dq.getAttributes();
  console.log('Queue attributes:', {
    maxEntryLength: attrs.maxEntryLength,
  });
} finally {
  await system.close();
}
