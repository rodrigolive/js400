import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', 'unsupported.md');
const SRC_PATH = path.join(ROOT, 'src');
const COMPAT_PATH = path.join(SRC_PATH, 'compat');

const requiredDocSnippets = [
  'com.ibm.as400.resource/*',
  'com.ibm.as400.vaccess/*',
  'com.ibm.as400.micro/*',
  'ProxyServer.java',
  '`*ImplNative.java` families',
  '`*BeanInfo.java`',
  'com.ibm.as400.util.servlet/*',
  'com.ibm.as400.util.html/*',
  'android/*',
  'JavaApplicationCall.java',
  'IFSJavaFile.java',
  'License family',
  '`module-info.java`',
  '`MRI*.java`',
  '`Converter.java`, `ConverterImplRemote.java`',
  '`AS400ConnectionPool.java`',
  '`AS400FTP.java`',
  '## JS-native replacements',
  '## Compat policy',
];

const forbiddenPatterns = [
  { label: 'IFSJavaFile', regex: /\bIFSJavaFile\b/u },
  { label: 'JavaApplicationCall', regex: /\bJavaApplicationCall(?:Thread)?\b/u },
  { label: '*BeanInfo', regex: /\b[A-Za-z0-9_]*BeanInfo\b/u },
  { label: '*ImplProxy', regex: /\b[A-Za-z0-9_]*ImplProxy\b/u },
  { label: '*ImplNative', regex: /\b[A-Za-z0-9_]*ImplNative\b/u },
  { label: 'ProxyServer', regex: /\bProxyServer\b/u },
  { label: 'Px*', regex: /\bPx[A-Za-z0-9_]*\b/u },
];

const allowedCompatFiles = new Set([
  'AS400ConnectionPool.js',
  'AS400FTP.js',
  'AS400JDBCDriverUrlParser.js',
]);

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('unsupported and compatibility guardrails', () => {
  it('maintains the unsupported or redesigned ledger', async () => {
    const docInfo = await stat(DOC_PATH);
    assert.ok(docInfo.isFile(), 'docs/unsupported.md must exist');

    const doc = await readFile(DOC_PATH, 'utf8');
    for (const snippet of requiredDocSnippets) {
      assert.match(doc, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
    }
  });

  it('keeps dropped Java-only families out of src', async () => {
    const files = await collectFiles(SRC_PATH);

    for (const file of files) {
      const relativePath = path.relative(ROOT, file);
      const contents = await readFile(file, 'utf8');

      for (const pattern of forbiddenPatterns) {
        assert.equal(
          pattern.regex.test(relativePath),
          false,
          `${relativePath} must not contain forbidden path token ${pattern.label}`,
        );
        assert.equal(
          pattern.regex.test(contents),
          false,
          `${relativePath} must not contain forbidden source token ${pattern.label}`,
        );
      }
    }
  });

  it('limits src/compat to the thin wrappers sanctioned by the repo map', async () => {
    const compatFiles = await collectFiles(COMPAT_PATH);

    for (const file of compatFiles) {
      const relativePath = path.relative(COMPAT_PATH, file);
      assert.equal(
        relativePath.includes(path.sep),
        false,
        `src/compat must not contain nested paths: ${relativePath}`,
      );
      assert.equal(
        allowedCompatFiles.has(relativePath),
        true,
        `src/compat contains unsupported wrapper ${relativePath}`,
      );
    }
  });
});
