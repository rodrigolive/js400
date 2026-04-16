/**
 * SQL package handling.
 *
 * Manages server-side SQL packages that cache prepared statement access plans.
 * Each package can hold multiple prepared statements.
 *
 * Upstream: JDPackageManager.java
 * @module db/engine/PackageManager
 */

export class PackageManager {
  #defaultPackage;
  #packages;

  constructor(opts = {}) {
    this.#defaultPackage = opts.defaultPackage || 'QSYS2/QSQJRN';
    this.#packages = new Map();
  }

  get defaultPackage() { return this.#defaultPackage; }

  getPackage(name) {
    return this.#packages.get(name) ?? null;
  }

  registerPackage(name, info) {
    this.#packages.set(name, info);
  }

  removePackage(name) {
    this.#packages.delete(name);
  }

  clear() {
    this.#packages.clear();
  }
}
