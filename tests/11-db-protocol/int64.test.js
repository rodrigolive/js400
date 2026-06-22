/**
 * Unit tests for the int64 coercion policy shared by the BIGINT decoder
 * and the AS400Bin8 / AS400UnsignedBin8 converters.
 */
import { describe, test, expect } from 'bun:test';
import { coerceInt64, normalizeBigintMode, BIGINT_MODES } from '../../src/db/types/int64.js';

const MAX_SAFE = 9007199254740991n;       // 2^53 - 1
const OVER_SAFE = 9007199254740993n;      // 2^53 + 1
const NEG_OVER_SAFE = -9007199254740993n; // -(2^53 + 1)
const MAX_U64 = 18446744073709551615n;    // 2^64 - 1

describe('coerceInt64 — auto (default)', () => {
  test('narrows small values to Number', () => {
    const v = coerceInt64(42n, 'auto');
    expect(typeof v).toBe('number');
    expect(v).toBe(42);
  });

  test('narrows zero and negatives within range', () => {
    expect(coerceInt64(0n, 'auto')).toBe(0);
    expect(coerceInt64(-1000n, 'auto')).toBe(-1000);
  });

  test('narrows at the safe-integer boundary 2^53-1', () => {
    const v = coerceInt64(MAX_SAFE, 'auto');
    expect(typeof v).toBe('number');
    expect(v).toBe(9007199254740991);
  });

  test('keeps BigInt just beyond the safe range (2^53+1)', () => {
    const v = coerceInt64(OVER_SAFE, 'auto');
    expect(typeof v).toBe('bigint');
    expect(v).toBe(OVER_SAFE);
  });

  test('keeps BigInt for negative values beyond the safe range', () => {
    expect(coerceInt64(NEG_OVER_SAFE, 'auto')).toBe(NEG_OVER_SAFE);
  });

  test('keeps BigInt for max uint64', () => {
    expect(coerceInt64(MAX_U64, 'auto')).toBe(MAX_U64);
  });

  test('unknown/undefined mode falls through to auto', () => {
    expect(coerceInt64(42n)).toBe(42);
    expect(coerceInt64(42n, 'nonsense')).toBe(42);
    expect(coerceInt64(OVER_SAFE, 'nonsense')).toBe(OVER_SAFE);
  });
});

describe('coerceInt64 — forced modes', () => {
  test('bigint: always native BigInt', () => {
    expect(coerceInt64(42n, 'bigint')).toBe(42n);
    expect(coerceInt64(MAX_U64, 'bigint')).toBe(MAX_U64);
  });

  test('number: always Number (lossy beyond 2^53, never throws)', () => {
    expect(coerceInt64(42n, 'number')).toBe(42);
    expect(typeof coerceInt64(OVER_SAFE, 'number')).toBe('number');
  });

  test('string: always a decimal string', () => {
    expect(coerceInt64(42n, 'string')).toBe('42');
    expect(coerceInt64(OVER_SAFE, 'string')).toBe('9007199254740993');
    expect(coerceInt64(NEG_OVER_SAFE, 'string')).toBe('-9007199254740993');
  });
});

describe('normalizeBigintMode', () => {
  test('passes through valid modes', () => {
    for (const mode of BIGINT_MODES) {
      expect(normalizeBigintMode(mode)).toBe(mode);
    }
  });

  test('clamps invalid/missing to auto', () => {
    expect(normalizeBigintMode(undefined)).toBe('auto');
    expect(normalizeBigintMode('long')).toBe('auto');
    expect(normalizeBigintMode(null)).toBe('auto');
  });
});
