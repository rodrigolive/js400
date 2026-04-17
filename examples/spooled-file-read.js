/**
 * Spooled file listing example.
 *
 * Lists spooled files in an output queue.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/spooled-file-read.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/spooled-file-read.js
 */

import { AS400, OutputQueue } from 'js400';

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

  const outq = new OutputQueue(system, '/QSYS.LIB/QUSRSYS.LIB/QPRINT.OUTQ');
  const spooledFiles = await outq.list();

  console.log(`Found ${spooledFiles.length} spooled file(s) in QPRINT:`);
  for (const sf of spooledFiles.slice(0, 10)) {
    console.log(`  ${sf.name}  #${sf.number}  ${sf.status}  ${sf.jobName}`);
  }

  if (spooledFiles.length > 10) {
    console.log(`  ... and ${spooledFiles.length - 10} more.`);
  }
} finally {
  await system.close();
}
