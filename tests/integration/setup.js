/**
 * Integration test setup — reads IBM i connection details from
 * environment variables and provides skip logic for when they
 * are absent.
 *
 * Required env vars:
 *   JS400_TEST_HOST     - IBM i hostname or IP
 *   JS400_TEST_USER     - User ID
 *   JS400_TEST_PASSWORD - Password
 *
 * Optional env vars:
 *   JS400_TEST_SIGNON_PORT   - Override signon port (default: 8476)
 *   JS400_TEST_COMMAND_PORT  - Override command port (default: 8475)
 *   JS400_TEST_DATABASE_PORT - Override database port (default: 8471)
 *   JS400_TEST_USE_TLS       - Set to 'true' to use TLS
 *   JS400_TEST_LIBRARY       - Test library name (default: JS400TEST)
 *
 * Usage in tests:
 *   import { config, skipIfNoHost, describeIntegration } from './setup.js';
 *   describeIntegration('my suite', () => { ... });
 */

const env = process.env;

export const config = Object.freeze({
  host:         env.JS400_TEST_HOST || '',
  user:         env.JS400_TEST_USER || '',
  password:     env.JS400_TEST_PASSWORD || '',
  signonPort:   parseInt(env.JS400_TEST_SIGNON_PORT || '8476', 10),
  commandPort:  parseInt(env.JS400_TEST_COMMAND_PORT || '8475', 10),
  databasePort: parseInt(env.JS400_TEST_DATABASE_PORT || '8471', 10),
  useTls:       env.JS400_TEST_USE_TLS === 'true',
  testLibrary:  env.JS400_TEST_LIBRARY || 'JS400TEST',
});

export const hasHost = !!(config.host && config.user && config.password);

/**
 * Skip the current test if no IBM i host is configured.
 * Call this at the top of each integration test.
 */
export function skipIfNoHost(testContext) {
  if (!hasHost) {
    testContext.skip('No IBM i host configured (set JS400_TEST_HOST, JS400_TEST_USER, JS400_TEST_PASSWORD)');
  }
}

/**
 * Describe wrapper that only runs when integration env vars are present.
 * Falls back to describe.skip when host is absent.
 */
export function describeIntegration(name, fn) {
  const { describe } = await_bun_test();
  if (hasHost) {
    describe(`[integration] ${name}`, fn);
  } else {
    describe.skip(`[integration] ${name} (no host)`, fn);
  }
}

function await_bun_test() {
  // Dynamic import avoided — callers should use top-level import.
  // This is a fallback for environments where bun:test is available globally.
  try {
    return globalThis.Bun ? require('bun:test') : { describe: { skip: () => {} } };
  } catch {
    return { describe: { skip: () => {} } };
  }
}
