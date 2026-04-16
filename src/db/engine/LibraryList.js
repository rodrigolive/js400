/**
 * Library list management.
 *
 * Manages the server-side library list for a database connection,
 * including initial configuration and runtime changes.
 *
 * Upstream: JDLibraryList.java
 * @module db/engine/LibraryList
 */

export class LibraryList {
  #libraries;
  #defaultSchema;

  constructor(opts = {}) {
    this.#libraries = [...(opts.libraries || [])];
    this.#defaultSchema = opts.defaultSchema || '';
  }

  get libraries() { return [...this.#libraries]; }
  get defaultSchema() { return this.#defaultSchema; }

  set defaultSchema(schema) {
    this.#defaultSchema = schema;
  }

  addLibrary(name) {
    const upper = name.toUpperCase();
    if (!this.#libraries.includes(upper)) {
      this.#libraries.push(upper);
    }
  }

  removeLibrary(name) {
    const upper = name.toUpperCase();
    const idx = this.#libraries.indexOf(upper);
    if (idx >= 0) this.#libraries.splice(idx, 1);
  }

  hasLibrary(name) {
    return this.#libraries.includes(name.toUpperCase());
  }

  toSetPathSQL() {
    if (this.#libraries.length === 0) return null;
    const schemas = this.#libraries.map(l => `"${l}"`).join(', ');
    return `SET PATH ${schemas}`;
  }

  toSetSchemaSQL() {
    if (!this.#defaultSchema) return null;
    return `SET SCHEMA "${this.#defaultSchema}"`;
  }
}
