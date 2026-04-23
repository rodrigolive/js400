/**
 * Compatibility layer that implements bun:test API surface using
 * node:test and node:assert.
 *
 * Supports: describe, test, it, expect, beforeEach, afterEach,
 *           beforeAll, afterAll, test.skip, test.skipIf,
 *           describe.skip
 */

import { describe as nodeDescribe, it as nodeIt, before, after, beforeEach as nodeBE, afterEach as nodeAE } from 'node:test';
import assert from 'node:assert/strict';

export function describe(name, fn) {
  return nodeDescribe(name, fn);
}

describe.skip = function skipDescribe(name, fn) {
  return nodeDescribe(name, { skip: true }, fn);
};

export function test(name, fn) {
  return nodeIt(name, fn);
}

test.skip = function skipTest(name, fn) {
  return nodeIt(name, { skip: true }, fn);
};

test.skipIf = function skipIf(condition) {
  return function (name, fn) {
    if (condition) {
      return nodeIt(name, { skip: true }, fn);
    }
    return nodeIt(name, fn);
  };
};

export { test as it };

export function beforeEach(fn) {
  return nodeBE(fn);
}

export function afterEach(fn) {
  return nodeAE(fn);
}

export function beforeAll(fn) {
  return before(fn);
}

export function afterAll(fn) {
  return after(fn);
}

/**
 * Minimal expect() compatible with bun:test's API.
 */
export function expect(actual) {
  return new Expectation(actual);
}

function assertPartialDeepStrictEqual(actual, expected, path = 'value') {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `Expected ${path} to be an array`);
    assert.ok(actual.length >= expected.length, `Expected ${path} length >= ${expected.length}`);
    for (let i = 0; i < expected.length; i += 1) {
      assertPartialDeepStrictEqual(actual[i], expected[i], `${path}[${i}]`);
    }
    return;
  }

  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `Expected ${path} to be an object`);
    for (const key of Object.keys(expected)) {
      assert.ok(key in Object(actual), `Expected ${path} to have property "${key}"`);
      assertPartialDeepStrictEqual(actual[key], expected[key], `${path}.${key}`);
    }
    return;
  }

  assert.deepStrictEqual(actual, expected);
}

class Expectation {
  #actual;
  #not = false;

  constructor(actual) {
    this.#actual = actual;
  }

  get not() {
    const neg = new Expectation(this.#actual);
    neg.#not = true;
    return neg;
  }

  toBe(expected) {
    if (this.#not) {
      assert.notStrictEqual(this.#actual, expected);
    } else {
      assert.strictEqual(this.#actual, expected);
    }
  }

  toEqual(expected) {
    if (this.#not) {
      assert.notDeepStrictEqual(this.#actual, expected);
    } else {
      assert.deepStrictEqual(this.#actual, expected);
    }
  }

  toMatchObject(expected) {
    if (this.#not) {
      let matched = true;
      try {
        assertPartialDeepStrictEqual(this.#actual, expected);
      } catch {
        matched = false;
      }
      assert.ok(!matched, 'Expected value not to match object');
    } else {
      assertPartialDeepStrictEqual(this.#actual, expected);
    }
  }

  toBeDefined() {
    if (this.#not) {
      assert.strictEqual(this.#actual, undefined);
    } else {
      assert.notStrictEqual(this.#actual, undefined);
    }
  }

  toBeUndefined() {
    if (this.#not) {
      assert.notStrictEqual(this.#actual, undefined);
    } else {
      assert.strictEqual(this.#actual, undefined);
    }
  }

  toBeNull() {
    if (this.#not) {
      assert.notStrictEqual(this.#actual, null);
    } else {
      assert.strictEqual(this.#actual, null);
    }
  }

  toBeInstanceOf(cls) {
    if (this.#not) {
      assert.ok(!(this.#actual instanceof cls), `Expected not instance of ${cls.name}`);
    } else {
      assert.ok(this.#actual instanceof cls, `Expected instance of ${cls.name}, got ${typeof this.#actual}`);
    }
  }

  toBeGreaterThan(expected) {
    if (this.#not) {
      assert.ok(!(this.#actual > expected), `Expected ${this.#actual} not > ${expected}`);
    } else {
      assert.ok(this.#actual > expected, `Expected ${this.#actual} > ${expected}`);
    }
  }

  toBeGreaterThanOrEqual(expected) {
    if (this.#not) {
      assert.ok(!(this.#actual >= expected), `Expected ${this.#actual} not >= ${expected}`);
    } else {
      assert.ok(this.#actual >= expected, `Expected ${this.#actual} >= ${expected}`);
    }
  }

  toBeLessThan(expected) {
    if (this.#not) {
      assert.ok(!(this.#actual < expected));
    } else {
      assert.ok(this.#actual < expected, `Expected ${this.#actual} < ${expected}`);
    }
  }

  toBeLessThanOrEqual(expected) {
    if (this.#not) {
      assert.ok(!(this.#actual <= expected));
    } else {
      assert.ok(this.#actual <= expected, `Expected ${this.#actual} <= ${expected}`);
    }
  }

  toBeTruthy() {
    if (this.#not) {
      assert.ok(!this.#actual);
    } else {
      assert.ok(this.#actual);
    }
  }

  toBeFalsy() {
    if (this.#not) {
      assert.ok(this.#actual);
    } else {
      assert.ok(!this.#actual);
    }
  }

  toBeNaN() {
    if (this.#not) {
      assert.ok(!Number.isNaN(this.#actual));
    } else {
      assert.ok(Number.isNaN(this.#actual));
    }
  }

  toContain(expected) {
    if (typeof this.#actual === 'string') {
      if (this.#not) {
        assert.ok(!this.#actual.includes(expected), `Expected string not to contain "${expected}"`);
      } else {
        assert.ok(this.#actual.includes(expected), `Expected string to contain "${expected}"`);
      }
    } else if (Array.isArray(this.#actual)) {
      if (this.#not) {
        assert.ok(!this.#actual.includes(expected), `Expected array not to contain ${expected}`);
      } else {
        assert.ok(this.#actual.includes(expected), `Expected array to contain ${expected}`);
      }
    } else {
      throw new Error('toContain only works with strings and arrays');
    }
  }

  toMatch(pattern) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    if (this.#not) {
      assert.ok(!regex.test(this.#actual), `Expected "${this.#actual}" not to match ${regex}`);
    } else {
      assert.match(this.#actual, regex);
    }
  }

  toHaveLength(expected) {
    if (this.#not) {
      assert.notStrictEqual(this.#actual.length, expected);
    } else {
      assert.strictEqual(this.#actual.length, expected);
    }
  }

  toHaveProperty(prop, value) {
    const hasProp = prop in Object(this.#actual);
    if (this.#not) {
      assert.ok(!hasProp, `Expected not to have property "${prop}"`);
    } else {
      assert.ok(hasProp, `Expected to have property "${prop}"`);
      if (arguments.length > 1) {
        assert.deepStrictEqual(this.#actual[prop], value);
      }
    }
  }

  toThrow(expected) {
    const checkError = (err) => {
      if (!expected) return;
      if (typeof expected === 'string') {
        const re = new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        assert.ok(err && re.test(err.message),
          `Expected error message matching "${expected}" but got "${err && err.message}"`);
      } else if (expected instanceof RegExp) {
        assert.match(err && err.message, expected);
      } else {
        assert.throws(() => { throw err; }, expected);
      }
    };

    const failMissing = () => assert.fail('Missing expected exception.');

    if (this.#not) {
      try {
        const result = this.#actual();
        if (result && typeof result.then === 'function') {
          return result.then(
            () => {},
            () => assert.fail('Expected function not to throw'),
          );
        }
      } catch {
        assert.fail('Expected function not to throw');
      }
    } else {
      try {
        const result = this.#actual();
        if (result && typeof result.then === 'function') {
          return result.then(failMissing, checkError);
        }
        failMissing();
      } catch (err) {
        checkError(err);
      }
    }
  }

  toBeCloseTo(expected, numDigits = 5) {
    const diff = Math.abs(this.#actual - expected);
    const threshold = Math.pow(10, -numDigits) / 2;
    if (this.#not) {
      assert.ok(diff >= threshold, `Expected ${this.#actual} not to be close to ${expected}`);
    } else {
      assert.ok(diff < threshold, `Expected ${this.#actual} to be close to ${expected} (diff: ${diff})`);
    }
  }

  resolves = {
    toBe: async (expected) => {
      const result = await this.#actual;
      assert.strictEqual(result, expected);
    },
    toEqual: async (expected) => {
      const result = await this.#actual;
      assert.deepStrictEqual(result, expected);
    },
    toBeDefined: async () => {
      const result = await this.#actual;
      assert.notStrictEqual(result, undefined);
    },
  };

  rejects = {
    toThrow: async (expected) => {
      try {
        await this.#actual;
        assert.fail('Expected promise to reject');
      } catch (err) {
        if (expected) {
          if (typeof expected === 'string') {
            assert.ok(err.message.includes(expected));
          } else if (expected instanceof RegExp) {
            assert.match(err.message, expected);
          }
        }
      }
    },
  };
}
