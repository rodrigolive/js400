#!/usr/bin/env node
// Build CJS bundles from ESM source using Bun's bundler.
// Post-processes to remove __esModule:true so Node.js CJS consumers
// get proper named exports instead of a namespace wrapper.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const entries = [
  ['src/index.js', 'cjs/index.js'],
  ['src/datatypes/index.js', 'cjs/datatypes.js'],
  ['src/pcml/index.js', 'cjs/pcml.js'],
  ['src/db/index.js', 'cjs/db.js'],
  ['src/print/index.js', 'cjs/print.js'],
  ['src/record/index.js', 'cjs/record.js'],
];

const outDir = path.resolve(__dirname, '..', 'cjs');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

for (const [src, out] of entries) {
  const absOut = path.resolve(__dirname, '..', out);
  execSync(`bun build ${src} --format cjs --outfile ${absOut} --target node`, {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });

  // Node.js CJS interop checks __esModule on module.exports. If true,
  // it treats the object as an ESM namespace and requires .default
  // instead of providing named exports. We neutralize the property so
  // require('js400').AS400 works directly.
  let code = fs.readFileSync(absOut, 'utf8');
  // Bun emits: entry = __defProp({}, "__esModule", { value: true });
  code = code.replace(
    /__defProp\(\s*\{\}\s*,\s*"__esModule"\s*,\s*\{\s*value:\s*true\s*\}\s*\)/,
    '{}'
  );
  fs.writeFileSync(absOut, code);
  console.log(`  patched ${out}`);
}

// Write a package.json into cjs/ so Node.js treats .js files there as CommonJS
// (the root package.json has "type": "module" which would otherwise make
// require() refuse to load them).
const cjsPkg = path.join(outDir, 'package.json');
fs.writeFileSync(cjsPkg, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
console.log('  wrote cjs/package.json');

console.log('CJS build complete.');
