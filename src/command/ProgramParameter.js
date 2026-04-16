/**
 * Parameter descriptor for program and service program calls.
 *
 * Upstream: ProgramParameter.java
 * @module command/ProgramParameter
 */

/** Pass-by-reference (default). */
const PASS_BY_REFERENCE = 2;
/** Pass-by-value (service programs only). */
const PASS_BY_VALUE = 1;

/** Parameter usage: input only. */
const INPUT = 1;
/** Parameter usage: output only. */
const OUTPUT = 2;
/** Parameter usage: input and output. */
const INOUT = 3;

export class ProgramParameter {
  static PASS_BY_REFERENCE = PASS_BY_REFERENCE;
  static PASS_BY_VALUE = PASS_BY_VALUE;
  static INPUT = INPUT;
  static OUTPUT = OUTPUT;
  static INOUT = INOUT;

  /** @type {Buffer|null} */
  #inputData = null;
  /** @type {Buffer|null} */
  #outputData = null;
  /** @type {number} */
  #outputLength = 0;
  /** @type {number} */
  #usage = INPUT;
  /** @type {number} */
  #passBy = PASS_BY_REFERENCE;
  /** @type {boolean} */
  #isNull = false;

  /**
   * Constructor shapes:
   *   new ProgramParameter()
   *   new ProgramParameter(outputLength)
   *   new ProgramParameter(inputData, outputLength)
   *   new ProgramParameter({ inputData, outputLength, usage, passBy })
   *
   * @param {Buffer|number|object} [dataOrLength]
   * @param {number} [outputLength]
   */
  constructor(dataOrLength, outputLength) {
    if (dataOrLength === undefined || dataOrLength === null) {
      return;
    }

    if (typeof dataOrLength === 'object' && !Buffer.isBuffer(dataOrLength) && !(dataOrLength instanceof Uint8Array)) {
      const opts = dataOrLength;
      if (opts.inputData != null) {
        this.#inputData = Buffer.isBuffer(opts.inputData)
          ? opts.inputData
          : Buffer.from(opts.inputData);
      }
      this.#outputLength = opts.outputLength ?? 0;
      if (opts.usage != null) this.#usage = opts.usage;
      if (opts.passBy != null) this.#passBy = opts.passBy;
      if (opts.isNull != null) this.#isNull = opts.isNull;
      if (this.#inputData && this.#outputLength > 0) {
        this.#usage = INOUT;
      } else if (this.#inputData && this.#outputLength === 0) {
        this.#usage = INPUT;
      } else if (!this.#inputData && this.#outputLength > 0) {
        this.#usage = OUTPUT;
      }
      if (opts.usage != null) this.#usage = opts.usage;
      return;
    }

    if (typeof dataOrLength === 'number') {
      this.#outputLength = dataOrLength;
      this.#usage = OUTPUT;
      return;
    }

    // Buffer input data
    this.#inputData = Buffer.isBuffer(dataOrLength)
      ? dataOrLength
      : Buffer.from(dataOrLength);
    this.#usage = INPUT;

    if (typeof outputLength === 'number' && outputLength > 0) {
      this.#outputLength = outputLength;
      this.#usage = INOUT;
    }
  }

  /** Get input data buffer. */
  getInputData() { return this.#inputData; }

  /** Set input data buffer. */
  setInputData(data) {
    this.#inputData = data != null
      ? (Buffer.isBuffer(data) ? data : Buffer.from(data))
      : null;
  }

  /** Get output data buffer (populated after call). */
  getOutputData() { return this.#outputData; }

  /** Set output data (called by reply parser). */
  setOutputData(data) {
    this.#outputData = data != null
      ? (Buffer.isBuffer(data) ? data : Buffer.from(data))
      : null;
  }

  /** Get requested output length in bytes. */
  getOutputDataLength() { return this.#outputLength; }

  /** Set requested output length in bytes. */
  setOutputDataLength(len) { this.#outputLength = len; }

  /** Get parameter usage (INPUT, OUTPUT, INOUT). */
  getUsage() { return this.#usage; }

  /** Set parameter usage. */
  setUsage(u) { this.#usage = u; }

  /** Get pass-by mode (PASS_BY_REFERENCE or PASS_BY_VALUE). */
  getPassBy() { return this.#passBy; }

  /** Set pass-by mode. */
  setPassBy(v) { this.#passBy = v; }

  /** Whether this is a null parameter. */
  isNullParameter() { return this.#isNull; }

  /** Set null parameter flag. */
  setNullParameter(v) { this.#isNull = v; }

  /**
   * Get the byte length to send on the wire.
   * For input/inout: input data length.
   * For output: 0 (no data sent).
   */
  getInputLength() {
    if (this.#isNull) return 0;
    if (this.#usage === OUTPUT) return 0;
    return this.#inputData ? this.#inputData.length : 0;
  }

  /**
   * Get the maximum output size for this parameter.
   * For output/inout: outputLength.
   * For input: 0.
   */
  getMaxOutputSize() {
    if (this.#usage === INPUT) return 0;
    return this.#outputLength;
  }
}
