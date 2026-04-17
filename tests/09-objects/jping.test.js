/**
 * Unit tests for JPing.
 */

import { describe, it, expect } from 'bun:test';
import { JPing } from '../../src/objects/JPing.js';

describe('JPing', () => {
  it('requires a host', () => {
    expect(() => new JPing(null)).toThrow('requires a host');
    expect(() => new JPing('')).toThrow('requires a host');
  });

  it('constructs with host', () => {
    const jp = new JPing('myhost.example.com');
    expect(jp).toBeDefined();
  });

  it('constructs with options', () => {
    const jp = new JPing('myhost.example.com', { timeout: 3000, secure: true });
    expect(jp).toBeDefined();
  });

  it('ping returns false for unreachable host', async () => {
    const jp = new JPing('192.0.2.1', { timeout: 500 });
    const result = await jp.ping(7); // SIGNON service
    expect(result).toBe(false);
  });

  it('pingAllServices returns results for all services', async () => {
    const jp = new JPing('192.0.2.1', { timeout: 500 });
    const results = await jp.pingAllServices();
    expect(typeof results).toBe('object');
    // All should be false for unreachable host
    for (const val of Object.values(results)) {
      expect(val).toBe(false);
    }
  });
});
