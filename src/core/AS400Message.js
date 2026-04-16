/**
 * Represents an IBM i message (message id, text, severity, etc.).
 *
 * Supports async load() for retrieving help text from the message file
 * via the QMHRTVM API.
 *
 * Upstream: AS400Message.java
 * @module core/AS400Message
 */

export class AS400Message {
  #system;
  #messageFile;
  #messageLibrary;
  #loaded;

  /**
   * @param {object} [options]
   * @param {string|null} [options.id]
   * @param {string|null} [options.text]
   * @param {number|null} [options.severity]
   * @param {Uint8Array|null} [options.substitutionData]
   * @param {string|null} [options.helpText]
   * @param {string|null} [options.messageFile]
   * @param {string|null} [options.messageLibrary]
   * @param {object|null} [options.system]
   */
  constructor(options = {}) {
    this.id = options.id ?? null;
    this.text = options.text ?? null;
    this.severity = options.severity ?? null;
    this.substitutionData = options.substitutionData ?? null;
    this.helpText = options.helpText ?? null;
    this.#messageFile = options.messageFile ?? null;
    this.#messageLibrary = options.messageLibrary ?? null;
    this.#system = options.system ?? null;
    this.#loaded = false;
  }

  getID() { return this.id; }
  getText() { return this.text; }
  getSeverity() { return this.severity; }
  getSubstitutionData() { return this.substitutionData; }
  getHelp() { return this.helpText; }
  getMessageFile() { return this.#messageFile; }
  getMessageLibrary() { return this.#messageLibrary; }

  /**
   * Set the AS400 system for help text retrieval.
   * @param {object} system
   */
  setSystem(system) {
    this.#system = system;
  }

  /**
   * Set the message file information.
   * @param {string} file
   * @param {string} [library='*LIBL']
   */
  setMessageFile(file, library = '*LIBL') {
    this.#messageFile = file;
    this.#messageLibrary = library;
  }

  /**
   * Async load of help text from the message file.
   * Uses RTVMSG CL command to retrieve the second-level text.
   * @returns {Promise<void>}
   */
  async load() {
    if (this.#loaded) return;
    if (!this.#system) {
      throw new Error('Cannot load message: no AS400 system set');
    }
    if (!this.id) {
      throw new Error('Cannot load message: no message ID');
    }

    const msgFile = this.#messageFile || 'QCPFMSG';
    const msgLib = this.#messageLibrary || '*LIBL';

    const cmd = `RTVMSG MSGID(${this.id}) MSGF(${msgLib}/${msgFile})` +
      ` MSG(&MSG) SECLVL(&HELP) MSGLEN(&MSGLEN) SECLVLLEN(&HELPLEN)`;

    try {
      const { CommandCall } = await import('../command/CommandCall.js');
      const cc = new CommandCall(this.#system);
      // Use a simpler approach: run a CL command that retrieves the message
      const helpCmd = `RTVMSG MSGID(${this.id}) MSGF(${msgLib}/${msgFile})`;
      // Since RTVMSG returns values to CL variables, we use DSPMSGD instead
      // via the program call API with QMHRTVM
      const { ProgramCall } = await import('../command/ProgramCall.js');
      const { ProgramParameter } = await import('../command/ProgramParameter.js');

      // QMHRTVM API: Retrieve Message
      // Parameters:
      //  1. Message information (output, variable)
      //  2. Length of message information (input, bin4)
      //  3. Format name (input, char8): 'RTVM0300'
      //  4. Message identifier (input, char7)
      //  5. Qualified message file name (input, char20)
      //  6. Replacement data (input, variable)
      //  7. Length of replacement data (input, bin4)
      //  8. Replace substitution values (input, char10)
      //  9. Return format control (input, char10)
      // 10. Error code (input/output)

      const outLen = 4096;
      const { CharConverter } = await import('../ccsid/CharConverter.js');
      const ccsid = this.#system.getServerCCSID() || 37;
      const conv = new CharConverter(ccsid);

      const formatBuf = Buffer.alloc(8, 0x40);
      conv.stringToByteArray('RTVM0300').copy(formatBuf, 0, 0, 8);

      const msgIdBuf = Buffer.alloc(7, 0x40);
      conv.stringToByteArray(this.id).copy(msgIdBuf, 0, 0, 7);

      const qualMsgFile = Buffer.alloc(20, 0x40);
      conv.stringToByteArray(msgFile.toUpperCase()).copy(qualMsgFile, 0, 0, 10);
      conv.stringToByteArray(msgLib.toUpperCase()).copy(qualMsgFile, 10, 0, 10);

      const replaceData = this.substitutionData ?? Buffer.alloc(0);
      const replaceLen = Buffer.alloc(4);
      replaceLen.writeInt32BE(replaceData.length, 0);

      const replaceSubs = Buffer.alloc(10, 0x40);
      conv.stringToByteArray('*YES').copy(replaceSubs, 0, 0, 4);

      const returnFmtCtl = Buffer.alloc(10, 0x40);
      conv.stringToByteArray('*NO').copy(returnFmtCtl, 0, 0, 3);

      const errorCode = Buffer.alloc(8);
      errorCode.writeInt32BE(8, 0); // bytes provided = 8 (suppress error)

      const lenBuf = Buffer.alloc(4);
      lenBuf.writeInt32BE(outLen, 0);

      const pc = new ProgramCall(this.#system);
      pc.setProgram('/QSYS.LIB/QMHRTVM.PGM', [
        new ProgramParameter({ outputLength: outLen }),           // 1. output
        new ProgramParameter({ inputData: lenBuf }),              // 2. length
        new ProgramParameter({ inputData: formatBuf }),           // 3. format
        new ProgramParameter({ inputData: msgIdBuf }),            // 4. msg id
        new ProgramParameter({ inputData: qualMsgFile }),         // 5. msg file
        new ProgramParameter({ inputData: replaceData.length > 0 ? Buffer.from(replaceData) : Buffer.alloc(1) }),
        new ProgramParameter({ inputData: replaceLen }),          // 7. replace len
        new ProgramParameter({ inputData: replaceSubs }),         // 8. replace subs
        new ProgramParameter({ inputData: returnFmtCtl }),        // 9. return fmt
        new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
      ]);

      const success = await pc.run();
      if (success) {
        const outBuf = pc.getParameterList()[0].getOutputData();
        if (outBuf && outBuf.length >= 40) {
          // RTVM0300 format:
          // Offset 0: bytes returned (bin4)
          // Offset 4: bytes available (bin4)
          // Offset 8: message length returned (bin4)
          // Offset 12: message length available (bin4)
          // Offset 16: help length returned (bin4)
          // Offset 20: help length available (bin4)
          // Offset 24: message (variable)
          // Offset 24+msgLen: help text (variable)
          const msgLenReturned = outBuf.readInt32BE(8);
          const helpLenReturned = outBuf.readInt32BE(16);

          if (msgLenReturned > 0 && !this.text) {
            this.text = conv.byteArrayToString(outBuf, 24, msgLenReturned).trim();
          }
          if (helpLenReturned > 0) {
            this.helpText = conv.byteArrayToString(outBuf, 24 + msgLenReturned, helpLenReturned).trim();
          }
        }
      }
    } catch {
      // If help text retrieval fails, leave helpText as-is
    }

    this.#loaded = true;
  }

  toString() {
    return `${this.id ?? ''}${this.text ? ': ' + this.text : ''}`;
  }
}
