/**
 * PCML document example.
 *
 * Demonstrates loading a PCML definition and calling a program
 * with automatic parameter marshalling.
 *
 * Usage:
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass node examples/pcml-document.js
 *   JS400_HOST=ibmi JS400_USER=user JS400_PASS=pass bun examples/pcml-document.js
 */

import { AS400 } from 'js400';
import { ProgramCallDocument } from 'js400/pcml';

const host = process.env.JS400_HOST;
const user = process.env.JS400_USER;
const password = process.env.JS400_PASS;

if (!host || !user || !password) {
  console.error('Set JS400_HOST, JS400_USER, and JS400_PASS environment variables.');
  process.exit(1);
}

// Inline PCML describing a simple echo program.
// Replace this with a PCML file path or your own program's PCML.
const pcmlXml = `
<pcml version="6.0">
  <program name="echo" path="/QSYS.LIB/JS400TEST.LIB/TESTPROC.PGM">
    <data name="inputValue" type="char" length="10" usage="input"/>
    <data name="outputValue" type="char" length="10" usage="output"/>
  </program>
</pcml>
`;

const system = new AS400({ host, user, password });

try {
  await system.signon();

  const doc = new ProgramCallDocument(system, pcmlXml);
  await doc.load();

  // Set input values
  doc.setValue('echo.inputValue', 'HELLO');

  // Call the program
  const success = await doc.callProgram('echo');
  console.log('Success:', success);

  // Read output values
  const output = doc.getValue('echo.outputValue');
  console.log('Output:', output);

  // Check messages
  for (const msg of doc.getMessageList('echo')) {
    console.log(`  ${msg.id}: ${msg.text}`);
  }
} finally {
  await system.close();
}
