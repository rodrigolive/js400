/**
 * Shim that registers a module loader to redirect 'bun:test' imports
 * to a Node.js-compatible implementation using node:test and node:assert.
 *
 * Usage: node --import ./tests/bun-test-shim.js --test tests/
 */

import { register } from 'node:module';

register('./bun-test-loader.js', import.meta.url);
