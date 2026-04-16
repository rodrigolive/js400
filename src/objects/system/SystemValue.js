/**
 * System value read/write API.
 *
 * Uses QWCRSVAL (Retrieve System Values) API via program calls.
 *
 * Upstream: SystemValue*.java, SystemValueGroup.java
 * @module objects/system/SystemValue
 */

import { AS400Error } from '../../core/errors.js';

export class SystemValue {
  #system;
  #name;
  #value;
  #loaded;

  /**
   * @param {import('../../core/AS400.js').AS400} system
   * @param {string} name - System value name (e.g. 'QDATE', 'QTIME', 'QMODEL')
   */
  constructor(system, name) {
    if (!system) throw new Error('SystemValue requires an AS400 instance');
    if (!name) throw new Error('SystemValue requires a name');
    this.#system = system;
    this.#name = name.toUpperCase();
    this.#value = null;
    this.#loaded = false;
  }

  getName() { return this.#name; }

  /**
   * Get the system value. Loads if not already loaded.
   * @returns {Promise<string|number|null>}
   */
  async getValue() {
    if (!this.#loaded) await this.load();
    return this.#value;
  }

  /**
   * Load the system value from the host.
   * Uses QWCRSVAL API.
   *
   * @returns {Promise<void>}
   */
  async load() {
    const { ProgramCall } = await import('../../command/ProgramCall.js');
    const { ProgramParameter } = await import('../../command/ProgramParameter.js');
    const { CharConverter } = await import('../../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    const outLen = 1024;

    // QWCRSVAL parameters:
    //  1. Receiver variable (output)
    //  2. Length of receiver variable (input, bin4)
    //  3. Number of system values (input, bin4)
    //  4. System value names (input, char10 array)
    //  5. Error code (input/output)

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(outLen, 0);

    const numValues = Buffer.alloc(4);
    numValues.writeInt32BE(1, 0);

    const valueName = Buffer.alloc(10, 0x40);
    conv.stringToByteArray(this.#name).copy(valueName, 0, 0, 10);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QWCRSVAL.PGM', [
      new ProgramParameter({ outputLength: outLen }),
      new ProgramParameter({ inputData: lenBuf }),
      new ProgramParameter({ inputData: numValues }),
      new ProgramParameter({ inputData: valueName }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const success = await pc.run();
    if (!success) {
      const msgs = pc.getMessageList();
      throw new AS400Error(
        `SystemValue load failed: ${msgs[0]?.text ?? 'unknown error'}`,
        { messageId: msgs[0]?.id, hostService: 'COMMAND' },
      );
    }

    const outBuf = pc.getParameterList()[0].getOutputData();
    if (outBuf && outBuf.length >= 20) {
      // Output format:
      // Offset 0: number of system values returned (bin4)
      // Offset 4: offset to first value entry (bin4)
      // Each entry:
      //   Offset 0: system value name (char10)
      //   Offset 10: type of data (char1) - 'C'=char, 'B'=binary, 'L'=logical
      //   Offset 11: information status (char1)
      //   Offset 12: length of data (bin4)
      //   Offset 16: data (variable)

      const numReturned = outBuf.readInt32BE(0);
      if (numReturned > 0) {
        const entryOffset = outBuf.readInt32BE(4);
        if (entryOffset + 16 <= outBuf.length) {
          const dataType = conv.byteArrayToString(outBuf, entryOffset + 10, 1);
          const dataLen = outBuf.readInt32BE(entryOffset + 12);

          if (dataLen > 0 && entryOffset + 16 + dataLen <= outBuf.length) {
            if (dataType === 'C') {
              this.#value = conv.byteArrayToString(outBuf, entryOffset + 16, dataLen).trim();
            } else if (dataType === 'B') {
              if (dataLen === 4) {
                this.#value = outBuf.readInt32BE(entryOffset + 16);
              } else {
                this.#value = outBuf.subarray(entryOffset + 16, entryOffset + 16 + dataLen);
              }
            } else {
              this.#value = conv.byteArrayToString(outBuf, entryOffset + 16, dataLen).trim();
            }
          }
        }
      }
    }

    this.#loaded = true;
  }

  /**
   * Retrieve a group of system values.
   * @param {import('../../core/AS400.js').AS400} system
   * @param {string[]} names
   * @returns {Promise<Record<string, string|number|null>>}
   */
  static async getGroup(system, names) {
    const results = {};
    const promises = names.map(async (name) => {
      const sv = new SystemValue(system, name);
      try {
        await sv.load();
        results[name] = sv.#value;
      } catch {
        results[name] = null;
      }
    });
    await Promise.all(promises);
    return results;
  }
}
