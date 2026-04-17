/**
 * IFS file read and write example.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/ifs-read-write.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/ifs-read-write.js
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
  const fs = system.ifs();

  const testDir = '/tmp/js400-example';
  const testFile = `${testDir}/hello.txt`;

  // Create directory
  await fs.mkdirs(testDir);
  console.log('Created directory:', testDir);

  // Write a text file
  await fs.writeFile(testFile, 'Hello from js400!\nThis is a test file.\n');
  console.log('Wrote file:', testFile);

  // Read it back
  const data = await fs.readFile(testFile);
  console.log('Read file contents:');
  console.log(data.toString());

  // Get file info
  const info = await fs.stat(testFile);
  console.log('File info:', {
    exists: info.exists,
    isFile: info.isFile,
    size: info.size,
  });

  // List directory
  const entries = await fs.readdir(testDir);
  console.log('Directory listing:', entries);

  // Clean up
  await fs.unlink(testFile);
  console.log('Deleted test file.');
} finally {
  await system.close();
}
