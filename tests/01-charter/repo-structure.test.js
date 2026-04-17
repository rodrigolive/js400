/**
 * Smoke tests validating project structure and module exports.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

describe('repo structure', () => {
  test('package.json exists and has correct name', async () => {
    const pkg = await import(join(ROOT, 'package.json'), { with: { type: 'json' } });
    expect(pkg.default.name).toBe('js400');
    expect(pkg.default.type).toBe('module');
  });

  test('src/index.js is the main entry point', () => {
    expect(existsSync(join(ROOT, 'src', 'index.js'))).toBe(true);
  });

  test('required source directories exist', () => {
    const dirs = [
      'src/core', 'src/transport', 'src/auth', 'src/ccsid',
      'src/datatypes', 'src/command', 'src/db', 'src/ifs',
      'src/record', 'src/objects', 'src/print', 'src/pcml',
    ];
    for (const dir of dirs) {
      expect(existsSync(join(ROOT, dir))).toBe(true);
    }
  });

  test('types directory exists', () => {
    expect(existsSync(join(ROOT, 'types'))).toBe(true);
  });

  test('test fixture directories exist', () => {
    const dirs = [
      'tests/fixtures/protocol',
      'tests/fixtures/ccsid',
      'tests/fixtures/datatypes',
      'tests/fixtures/auth',
      'tests/fixtures/pcml',
      'tests/fixtures/print',
    ];
    for (const dir of dirs) {
      expect(existsSync(join(ROOT, dir))).toBe(true);
    }
  });
});

describe('main module exports', () => {
  test('exports core classes', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.AS400).toBeDefined();
    expect(mod.Trace).toBeDefined();
    expect(mod.DataStream).toBeDefined();
    expect(mod.Connection).toBeDefined();
    expect(mod.PortMapper).toBeDefined();
  });

  test('exports auth utilities', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.encryptPassword).toBeDefined();
    expect(mod.stringToEbcdic).toBeDefined();
    expect(mod.ebcdicToString).toBeDefined();
    expect(mod.ProfileToken).toBeDefined();
  });

  test('exports command classes', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.ProgramCall).toBeDefined();
    expect(mod.CommandCall).toBeDefined();
    expect(mod.ServiceProgramCall).toBeDefined();
  });

  test('exports data type module', async () => {
    const mod = await import('../../src/datatypes/index.js');
    expect(mod.AS400PackedDecimal).toBeDefined();
    expect(mod.AS400ZonedDecimal).toBeDefined();
    expect(mod.AS400Text).toBeDefined();
  });

  test('exports SQL module', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.sql).toBeDefined();
  });

  test('exports IFS classes', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.IFSFile).toBeDefined();
    expect(mod.QSYSObjectPathName).toBeDefined();
  });

  test('exports object classes', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.DataQueue).toBeDefined();
    expect(mod.Job).toBeDefined();
    expect(mod.JobList).toBeDefined();
  });
});
