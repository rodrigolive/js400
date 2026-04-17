import { test, expect } from 'bun:test';
import { compressRLE, decompressRLE } from '../src/db/compression/rle.js';

function roundTrip(src) {
  const srcBuf = Buffer.from(src);
  const dst = Buffer.alloc(srcBuf.length * 2 + 32);
  const n = compressRLE(srcBuf, 0, srcBuf.length, dst, 0);
  if (n < 0) return { compressedLen: -1 };
  const out = Buffer.alloc(srcBuf.length);
  const m = decompressRLE(dst, 0, n, out, 0);
  return { compressedLen: n, decompressedLen: m, outBytes: out.subarray(0, m) };
}

test('RLE: unique bytes refuse to compress', () => {
  const src = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const dst = Buffer.alloc(src.length * 2 + 16);
  const n = compressRLE(src, 0, src.length, dst, 0);
  // Source has 4 unique pairs; compressRLE will detect no repeats and
  // copy literally — but the output equals source length, which triggers
  // the "written >= length" rejection and returns -1.
  expect(n).toBe(-1);
});

test('RLE: all-zero payload compresses heavily', () => {
  const src = Buffer.alloc(2000, 0);
  const dst = Buffer.alloc(src.length + 16);
  const n = compressRLE(src, 0, src.length, dst, 0);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(20); // expect <5x overhead; 1 repeater record is 5 bytes

  const out = Buffer.alloc(src.length);
  const m = decompressRLE(dst, 0, n, out, 0);
  expect(m).toBe(src.length);
  expect(out.equals(src)).toBe(true);
});

test('RLE: EBCDIC spaces (0x40 0x40) heavy payload', () => {
  const src = Buffer.alloc(4000, 0x40);
  const dst = Buffer.alloc(src.length + 16);
  const n = compressRLE(src, 0, src.length, dst, 0);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(5);
  const out = Buffer.alloc(src.length);
  const m = decompressRLE(dst, 0, n, out, 0);
  expect(m).toBe(src.length);
  expect(out.equals(src)).toBe(true);
});

test('RLE: literal 0x1B is escaped', () => {
  const src = Buffer.from([0x1B, 0x00, 0x01, 0x02, 0x1B, 0x03, 0x04]);
  const dst = Buffer.alloc(src.length * 3 + 16);
  const n = compressRLE(src, 0, src.length, dst, 0);
  // Likely no net compression; allowed to return -1.
  if (n >= 0) {
    const out = Buffer.alloc(src.length);
    const m = decompressRLE(dst, 0, n, out, 0);
    expect(m).toBe(src.length);
    expect(out.equals(src)).toBe(true);
  }
});

test('RLE: mixed real-world packet', () => {
  // Simulate INSERT batch: small CHAR values padded with spaces.
  const parts = [];
  for (let i = 0; i < 100; i++) {
    parts.push(Buffer.from([0xC1, 0xC2, 0xC3])); // 3-byte "value"
    parts.push(Buffer.alloc(30, 0x40));          // 30 bytes of EBCDIC space
    parts.push(Buffer.alloc(16, 0x00));          // 16 bytes of zero padding
  }
  const src = Buffer.concat(parts);
  const dst = Buffer.alloc(src.length + 16);
  const n = compressRLE(src, 0, src.length, dst, 0);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(src.length / 2);

  const out = Buffer.alloc(src.length);
  const m = decompressRLE(dst, 0, n, out, 0);
  expect(m).toBe(src.length);
  expect(out.equals(src)).toBe(true);
});

test('RLE: odd length tail', () => {
  const src = Buffer.alloc(1001, 0x40);
  src[1000] = 0xFF; // odd trailing byte
  const dst = Buffer.alloc(src.length + 16);
  const n = compressRLE(src, 0, src.length, dst, 0);
  expect(n).toBeGreaterThan(0);
  const out = Buffer.alloc(src.length);
  const m = decompressRLE(dst, 0, n, out, 0);
  expect(m).toBe(src.length);
  expect(out.equals(src)).toBe(true);
});

test('RLE: round-trip random-ish data', () => {
  const src = Buffer.alloc(5000);
  for (let i = 0; i < src.length; i++) {
    // Mostly 0x40 with occasional other bytes — typical of an INSERT payload.
    src[i] = (i % 40 === 0) ? (0xC0 + (i & 0x3F)) : 0x40;
  }
  const dst = Buffer.alloc(src.length + 16);
  const n = compressRLE(src, 0, src.length, dst, 0);
  expect(n).toBeGreaterThan(0);
  const out = Buffer.alloc(src.length);
  const m = decompressRLE(dst, 0, n, out, 0);
  expect(m).toBe(src.length);
  expect(out.equals(src)).toBe(true);
});
