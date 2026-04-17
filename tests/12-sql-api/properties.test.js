/**
 * Tests for connection property validation and normalization.
 */
import { describe, test, expect } from 'bun:test';
import {
  validateProperties, normalizeProperties, defaultProperties,
  Naming, DateFormat, TimeFormat,
} from '../../src/db/properties.js';

describe('validateProperties', () => {
  test('returns empty warnings for valid properties', () => {
    const warnings = validateProperties({
      naming: 'sql',
      libraries: ['MYLIB'],
      dateFormat: '*ISO',
      autoCommit: true,
    });
    expect(warnings).toEqual([]);
  });

  test('returns warnings for unknown properties', () => {
    const warnings = validateProperties({ unknownProp: 'foo' });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('unknownProp');
  });

  test('throws on invalid naming', () => {
    expect(() => validateProperties({ naming: 'bad' })).toThrow('Invalid naming');
  });

  test('throws on invalid dateFormat', () => {
    expect(() => validateProperties({ dateFormat: 'INVALID' })).toThrow('Invalid dateFormat');
  });

  test('throws on invalid timeFormat', () => {
    expect(() => validateProperties({ timeFormat: 'INVALID' })).toThrow('Invalid timeFormat');
  });

  test('throws on invalid isolation', () => {
    expect(() => validateProperties({ isolation: 'bad' })).toThrow('Invalid isolation');
  });

  test('throws when libraries is not an array', () => {
    expect(() => validateProperties({ libraries: 'MYLIB' })).toThrow('libraries must be an array');
  });

  test('throws on invalid blockSize', () => {
    expect(() => validateProperties({ blockSize: 999 })).toThrow('Invalid blockSize');
  });

  test('accepts all valid isolation levels', () => {
    const levels = ['none', 'read-uncommitted', 'read-committed', 'repeatable-read', 'serializable'];
    for (const level of levels) {
      expect(validateProperties({ isolation: level })).toEqual([]);
    }
  });

  test('accepts all valid date formats', () => {
    const formats = ['*ISO', '*USA', '*EUR', '*JIS', '*MDY', '*DMY', '*YMD', '*JUL'];
    for (const fmt of formats) {
      expect(validateProperties({ dateFormat: fmt })).toEqual([]);
    }
  });

  test('accepts all valid time formats', () => {
    const formats = ['*ISO', '*USA', '*EUR', '*JIS', '*HMS'];
    for (const fmt of formats) {
      expect(validateProperties({ timeFormat: fmt })).toEqual([]);
    }
  });
});

describe('normalizeProperties', () => {
  test('merges with defaults', () => {
    const result = normalizeProperties({ naming: 'system' });
    expect(result.naming).toBe('system');
    expect(result.dateFormat).toBe(defaultProperties.dateFormat);
    expect(result.autoCommit).toBe(defaultProperties.autoCommit);
  });

  test('converts string libraries to array', () => {
    const result = normalizeProperties({ libraries: 'LIB1, LIB2, LIB3' });
    expect(result.libraries).toEqual(['LIB1', 'LIB2', 'LIB3']);
  });

  test('normalizes boolean strings', () => {
    const result = normalizeProperties({ autoCommit: 'true', prefetch: '1', lazyClose: 'false' });
    expect(result.autoCommit).toBe(true);
    expect(result.prefetch).toBe(true);
    expect(result.lazyClose).toBe(false);
  });

  test('preserves array libraries', () => {
    const result = normalizeProperties({ libraries: ['A', 'B'] });
    expect(result.libraries).toEqual(['A', 'B']);
  });

  test('preserves boolean values', () => {
    const result = normalizeProperties({ autoCommit: false });
    expect(result.autoCommit).toBe(false);
  });
});
