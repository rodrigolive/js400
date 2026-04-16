# Dependency Policy

## Runtime dependencies

js400 has **zero** production dependencies. The entire library is pure JavaScript that runs on Node.js 20+ and Bun without native add-ons, C++ bindings, or platform-specific packages.

This is intentional. IBM i client libraries are infrastructure code that must be stable, auditable, and deployable without surprises. Every dependency is a surface for breakage, license risk, and supply-chain vulnerability.

## What js400 uses instead

| Capability | Approach |
| --- | --- |
| TCP sockets | `node:net` / `node:tls` (built-in) |
| Cryptography (DES, SHA-1, SHA-512) | `node:crypto` (built-in) |
| File I/O for tracing | `node:fs` (built-in) |
| Buffer and binary manipulation | `Buffer` / `Uint8Array` (built-in) |
| XML parsing for PCML | Lightweight built-in tokenizer (`src/pcml/xml.js`) |
| EBCDIC / CCSID conversion | Hand-rolled conversion tables (`src/ccsid/`) |
| Base64 encoding | `Buffer.from(str, 'base64')` (built-in) |

## Dev dependencies

The project keeps dev dependencies minimal as well. Testing uses the built-in `bun test` runner or `node --test`. There is no build step, no transpilation, and no bundler.

## Optional XML dependencies

If you need full XML parsing beyond what the built-in tokenizer handles (e.g., complex XPCML documents with namespaces), you can install a lightweight XML parser. js400 will use its built-in tokenizer by default and does not require any external XML library.

## Why sparse dependencies matter

1. **Audit surface** -- fewer packages to audit for CVEs and license compliance.
2. **Install speed** -- `npm install` or `bun add` completes in seconds, not minutes.
3. **Reproducibility** -- no transitive dependency graph to break on updates.
4. **IBM i context** -- many IBM i shops have restricted network access and cannot easily reach npm registries. A self-contained package deploys more reliably.

## Approved additions

If a future feature genuinely requires a dependency:

- It must be pure JavaScript (no native add-ons).
- It must have a clear, permissive license (MIT, ISC, BSD).
- It must solve a problem that cannot be reasonably solved with built-in Node APIs.
- It must be added as a `dependency`, not bundled or vendored.
- The reason for adding it must be documented in this file.

As of v0.1.0, no external dependencies have been approved.

Source: [`package.json`](../package.json)
