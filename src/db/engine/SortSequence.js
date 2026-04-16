/**
 * Sort sequence configuration.
 *
 * Controls collation/sort order for SQL string comparisons.
 *
 * Upstream: JDSortSequence.java
 * @module db/engine/SortSequence
 */

import { SortSequenceType } from '../properties.js';

export class SortSequence {
  #type;
  #table;
  #languageId;

  constructor(opts = {}) {
    this.#type = opts.type || SortSequenceType.HEX;
    this.#table = opts.table || '';
    this.#languageId = opts.languageId || '';
  }

  get type() { return this.#type; }
  get table() { return this.#table; }
  get languageId() { return this.#languageId; }

  toSetSQL() {
    switch (this.#type) {
      case SortSequenceType.HEX:
        return null;
      case SortSequenceType.JOB:
        return 'SET SORT SEQUENCE *JOB';
      case SortSequenceType.LANGIDUNQ:
        return `SET SORT SEQUENCE *LANGIDUNQ`;
      case SortSequenceType.LANGIDSHR:
        return `SET SORT SEQUENCE *LANGIDSHR`;
      case SortSequenceType.TABLE:
        if (this.#table) return `SET SORT SEQUENCE "${this.#table}"`;
        return null;
      default:
        return null;
    }
  }
}
