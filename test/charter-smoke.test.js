import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

describe('charter smoke tests', () => {
  it('src/index.js is importable and exports AS400', async () => {
    const mod = await import('../src/index.js');
    assert.ok(mod.AS400, 'AS400 must be exported');
    assert.strictEqual(typeof mod.AS400, 'function');
  });

  it('AS400 can be instantiated with a host', async () => {
    const { AS400 } = await import('../src/index.js');
    const sys = new AS400('testhost');
    assert.strictEqual(sys.host, 'testhost');
    assert.strictEqual(sys.user, '');
  });

  it('exports all expected top-level names', async () => {
    const mod = await import('../src/index.js');
    const expected = [
      'AS400',
      'ProgramCall',
      'ServiceProgramCall',
      'CommandCall',
      'ProgramParameter',
      'DataQueue',
      'KeyedDataQueue',
      'OutputQueue',
      'SpooledFile',
      'IFSFile',
      'IFSFileInputStream',
      'IFSFileOutputStream',
      'AS400Text',
      'AS400Bin4',
      'AS400PackedDecimal',
      'sql',
    ];
    for (const name of expected) {
      assert.ok(name in mod, `missing export: ${name}`);
    }
  });

  it('sql namespace exposes connect, createPool, parseJdbcUrl', async () => {
    const { sql } = await import('../src/index.js');
    assert.strictEqual(typeof sql.connect, 'function');
    assert.strictEqual(typeof sql.createPool, 'function');
    assert.strictEqual(typeof sql.parseJdbcUrl, 'function');
  });

  it('AS400 constructor stores host and user', async () => {
    const { AS400 } = await import('../src/index.js');
    const sys = new AS400('myhost', 'MYUSER');
    assert.strictEqual(sys.host, 'myhost');
    assert.strictEqual(sys.user, 'MYUSER');
  });

  it('package.json has correct name, type, and engines', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.strictEqual(pkg.name, 'js400');
    assert.strictEqual(pkg.type, 'module');
    assert.ok(pkg.engines?.node, 'engines.node must be set');
    assert.match(pkg.engines.node, />=20/);
  });

  it('has zero runtime dependencies', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    assert.strictEqual(deps.length, 0, `unexpected runtime deps: ${deps.join(', ')}`);
  });

  it('no Java files exist under src/', async () => {
    const { execSync } = await import('node:child_process');
    const result = execSync('find src/ -name "*.java" -o -name "*.jar" -o -name "*.class"', {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
    }).trim();
    assert.strictEqual(result, '', `Java artifacts found in src/: ${result}`);
  });
});
