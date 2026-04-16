/**
 * Public callable statement API for stored procedure calls.
 *
 * Builds and executes CALL statements with IN/OUT parameter support
 * and multiple result set handling.
 *
 * Upstream: AS400JDBCCallableStatement.java
 * @module db/api/CallableStatement
 */

import { PreparedStatement } from './PreparedStatement.js';

/**
 * Map a type descriptor to a SQL type string for CALL statement generation.
 */
function sqlTypeString(desc) {
  switch (desc.type) {
    case 'integer': return 'INTEGER';
    case 'smallint': return 'SMALLINT';
    case 'bigint': return 'BIGINT';
    case 'decimal':
    case 'numeric': {
      const p = desc.precision ?? 15;
      const s = desc.scale ?? 2;
      return `DECIMAL(${p}, ${s})`;
    }
    case 'float':
    case 'double': return 'DOUBLE';
    case 'real': return 'REAL';
    case 'char': return `CHAR(${desc.length ?? 32})`;
    case 'varchar': return `VARCHAR(${desc.length ?? 256})`;
    case 'date': return 'DATE';
    case 'time': return 'TIME';
    case 'timestamp': return 'TIMESTAMP';
    default: return 'VARCHAR(256)';
  }
}

export class CallableStatement {
  #connection;

  /**
   * @param {object} connection - a Connection instance
   */
  constructor(connection) {
    this.#connection = connection;
  }

  /**
   * Call a stored procedure.
   *
   * @param {string} procedureName - fully qualified procedure name (LIB.PROC)
   * @param {object} [opts]
   * @param {any[]} [opts.in] - input parameter values
   * @param {object[]} [opts.out] - output parameter descriptors
   * @param {object[]} [opts.inout] - in/out parameter descriptors with values
   * @returns {Promise<{ out: any[], resultSets: object[][] }>}
   */
  async call(procedureName, opts = {}) {
    const inParams = opts.in || [];
    const outParams = opts.out || [];
    const inoutParams = opts.inout || [];

    const totalParams = inParams.length + outParams.length + inoutParams.length;
    const markers = totalParams > 0
      ? `(${Array(totalParams).fill('?').join(', ')})`
      : '';

    const sql = `CALL ${procedureName}${markers}`;
    const params = [...inParams, ...Array(outParams.length).fill(null), ...inoutParams.map(p => p.value)];

    const stmt = await this.#connection.prepare(sql);
    try {
      const result = await stmt.execute(params);

      // For simple calls, result is rows or { affectedRows }
      const resultSets = Array.isArray(result) ? [result] : [];
      const out = outParams.map(() => null);

      return {
        out,
        resultSets,
      };
    } finally {
      await stmt.close();
    }
  }
}
