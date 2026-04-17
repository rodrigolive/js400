/**
 * Integration smoke test — validates that live IBM i tests skip
 * cleanly when environment variables are absent.
 */

import { describe, test, expect } from 'bun:test';
import { config, hasHost } from './setup.js';

describe('integration setup', () => {
  test('config object has expected shape', () => {
    expect(typeof config.host).toBe('string');
    expect(typeof config.user).toBe('string');
    expect(typeof config.password).toBe('string');
    expect(typeof config.signonPort).toBe('number');
    expect(typeof config.commandPort).toBe('number');
    expect(typeof config.databasePort).toBe('number');
    expect(typeof config.useTls).toBe('boolean');
    expect(typeof config.testLibrary).toBe('string');
  });

  test('hasHost reflects environment', () => {
    const envSet = !!(process.env.JS400_TEST_HOST &&
                      process.env.JS400_TEST_USER &&
                      process.env.JS400_TEST_PASSWORD);
    expect(hasHost).toBe(envSet);
  });

  test('default test library is JS400TEST', () => {
    if (!process.env.JS400_TEST_LIBRARY) {
      expect(config.testLibrary).toBe('JS400TEST');
    }
  });
});

describe('live connection tests', () => {
  test.skipIf(!hasHost)('placeholder for live signon test', () => {
    // This test only runs when IBM i credentials are configured
    expect(hasHost).toBe(true);
  });

  test.skipIf(!hasHost)('placeholder for live command test', () => {
    expect(hasHost).toBe(true);
  });

  test.skipIf(!hasHost)('placeholder for live SQL test', () => {
    expect(hasHost).toBe(true);
  });
});
