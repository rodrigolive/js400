/**
 * Node.js ESM loader hook that intercepts 'bun:test' imports and
 * redirects them to a compatibility shim using node:test + node:assert.
 */

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'bun:test') {
    return {
      shortCircuit: true,
      url: new URL('./bun-test-compat.js', import.meta.url).href,
    };
  }
  return nextResolve(specifier, context);
}
