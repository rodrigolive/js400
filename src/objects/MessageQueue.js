/**
 * Message queue read/send/load API.
 *
 * Uses QMHRCVPM (Receive Program Message) and QMHSNDM (Send Message)
 * IBM i APIs via program calls.
 *
 * Upstream: MessageQueue.java
 * @module objects/MessageQueue
 */

import { AS400Message } from '../core/AS400Message.js';
import { QSYSObjectPathName } from '../ifs/QSYSObjectPathName.js';

export class MessageQueue {
  #system;
  #path;
  #library;
  #name;

  /**
   * @param {import('../core/AS400.js').AS400} system
   * @param {string} path - IFS path like /QSYS.LIB/QUSRSYS.LIB/MYUSER.MSGQ
   */
  constructor(system, path) {
    if (!system) throw new Error('MessageQueue requires an AS400 instance');
    if (!path) throw new Error('MessageQueue requires a path');
    this.#system = system;
    this.#path = path;
    const parsed = QSYSObjectPathName.parse(path);
    this.#library = parsed.library;
    this.#name = parsed.object;
  }

  get path() { return this.#path; }
  get library() { return this.#library; }
  get name() { return this.#name; }

  /**
   * Receive messages from the queue.
   * Uses QMHRCVPM API to list messages.
   *
   * @param {object} [opts]
   * @param {string} [opts.type='*ALL'] - *OLD, *NEW, *ALL
   * @param {number} [opts.wait=0] - Seconds to wait
   * @param {number} [opts.maxMessages=100]
   * @returns {Promise<AS400Message[]>}
   */
  async receive(opts = {}) {
    const maxMessages = opts.maxMessages ?? 100;

    // Use QMHLSTM (List Messages) via command
    // Simpler approach: run DSPMSG via command call and parse messages
    // Best approach: use QGYOLMSG (Open List of Messages)
    // Practical approach: call RCVMSG CL command in a loop, or use QMHRCVPM

    // Use a CL command approach for simplicity:
    // RCVMSG MSGQ(lib/name) MSGTYPE(*ALL) RMV(*NO)
    const { ProgramCall } = await import('../command/ProgramCall.js');
    const { ProgramParameter } = await import('../command/ProgramParameter.js');
    const { CharConverter } = await import('../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    // Use QMHLSTM API or simpler QMHRCVPM
    // QMHRCVPM parameters:
    //  1. Message information (output)
    //  2. Length of message information (input, bin4)
    //  3. Format name (input, char8) - RCVM0200
    //  4. Call stack entry (input, char10) - '*'
    //  5. Call stack counter (input, bin4) - 0
    //  6. Message type (input, char10) - *ANY
    //  7. Message key (input, char4) - blanks
    //  8. Wait time (input, bin4) - wait seconds
    //  9. Message action (input, char10) - *OLD
    // 10. Error code (input/output)

    const messages = [];
    const outLen = 4096;

    const formatBuf = Buffer.alloc(8, 0x40);
    conv.stringToByteArray('RCVM0200').copy(formatBuf, 0, 0, 8);

    const callStack = Buffer.alloc(10, 0x40);
    callStack[0] = 0x5C; // * in EBCDIC

    const callStackCounter = Buffer.alloc(4);
    callStackCounter.writeInt32BE(0, 0);

    const msgType = Buffer.alloc(10, 0x40);
    conv.stringToByteArray('*ANY').copy(msgType, 0, 0, 4);

    const msgKey = Buffer.alloc(4, 0x00);

    const waitBuf = Buffer.alloc(4);
    waitBuf.writeInt32BE(opts.wait ?? 0, 0);

    const msgAction = Buffer.alloc(10, 0x40);
    conv.stringToByteArray('*OLD').copy(msgAction, 0, 0, 4);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeInt32BE(outLen, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QMHRCVPM.PGM', [
      new ProgramParameter({ outputLength: outLen }),
      new ProgramParameter({ inputData: lenBuf }),
      new ProgramParameter({ inputData: formatBuf }),
      new ProgramParameter({ inputData: callStack }),
      new ProgramParameter({ inputData: callStackCounter }),
      new ProgramParameter({ inputData: msgType }),
      new ProgramParameter({ inputData: msgKey }),
      new ProgramParameter({ inputData: waitBuf }),
      new ProgramParameter({ inputData: msgAction }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    const success = await pc.run();
    if (success) {
      const outBuf = pc.getParameterList()[0].getOutputData();
      if (outBuf && outBuf.length >= 20) {
        // RCVM0200 format:
        // Offset 0: bytes returned (bin4)
        // Offset 4: bytes available (bin4)
        // Offset 8: message severity (bin4)
        // Offset 12: message identifier (char7)
        // Offset 19: message type (char2)
        // Offset 21: message key (char4)
        // ... more fields
        // Offset 45: CCSID for text (bin4)
        // etc.
        const bytesReturned = outBuf.readInt32BE(0);
        if (bytesReturned > 12) {
          const severity = outBuf.readInt32BE(8);
          const msgId = conv.byteArrayToString(outBuf, 12, 7).trim();

          // Data & text offsets at RCVM0200 positions
          let text = '';
          let substData = null;

          if (bytesReturned >= 49) {
            const dataReturned = outBuf.readInt32BE(25);
            const textReturned = outBuf.readInt32BE(33);
            const dataOffset = 49 + dataReturned;

            if (dataReturned > 0) {
              substData = Buffer.alloc(dataReturned);
              outBuf.copy(substData, 0, 49, 49 + dataReturned);
            }
            if (textReturned > 0 && dataOffset + textReturned <= outBuf.length) {
              text = conv.byteArrayToString(outBuf, dataOffset, textReturned).trim();
            }
          }

          if (msgId) {
            messages.push(new AS400Message({
              id: msgId,
              text,
              severity,
              substitutionData: substData,
              system: this.#system,
            }));
          }
        }
      }
    }

    return messages;
  }

  /**
   * Send an informational message to the queue.
   * Uses QMHSNDM API.
   *
   * @param {string} text - Message text
   * @param {object} [opts]
   * @param {string} [opts.messageId] - Optional message ID (e.g., 'CPF9898')
   * @param {string} [opts.messageFile] - Message file name
   * @param {string} [opts.messageLibrary='*LIBL'] - Message file library
   * @returns {Promise<void>}
   */
  async sendInformational(text, opts = {}) {
    const { ProgramCall } = await import('../command/ProgramCall.js');
    const { ProgramParameter } = await import('../command/ProgramParameter.js');
    const { CharConverter } = await import('../ccsid/CharConverter.js');
    const ccsid = this.#system.getServerCCSID() || 37;
    const conv = new CharConverter(ccsid);

    // Use QMHSNDM API: Send Nonprogram Message
    // Parameters:
    //  1. Message identifier (input, char7)
    //  2. Qualified message file name (input, char20)
    //  3. Message data or immediate text (input, variable)
    //  4. Length of message data (input, bin4)
    //  5. Message type (input, char10)
    //  6. Qualified message queue names (input, char20 array)
    //  7. Number of message queues (input, bin4)
    //  8. Qualified reply message queue (input, char20)
    //  9. Message key (output, char4)
    // 10. Error code (input/output)

    const msgId = Buffer.alloc(7, 0x40);
    if (opts.messageId) {
      conv.stringToByteArray(opts.messageId).copy(msgId, 0, 0, 7);
    }

    const qualMsgFile = Buffer.alloc(20, 0x40);
    if (opts.messageFile) {
      conv.stringToByteArray(opts.messageFile.toUpperCase()).copy(qualMsgFile, 0, 0, 10);
      conv.stringToByteArray((opts.messageLibrary ?? '*LIBL').toUpperCase()).copy(qualMsgFile, 10, 0, 10);
    }

    const msgText = conv.stringToByteArray(text);
    const msgDataLen = Buffer.alloc(4);
    msgDataLen.writeInt32BE(msgText.length, 0);

    const msgType = Buffer.alloc(10, 0x40);
    conv.stringToByteArray('*INFO').copy(msgType, 0, 0, 5);

    // Target message queue (qualified name: name(10) + library(10))
    const qualMsgQ = Buffer.alloc(20, 0x40);
    conv.stringToByteArray(this.#name.toUpperCase()).copy(qualMsgQ, 0, 0, 10);
    conv.stringToByteArray(this.#library.toUpperCase()).copy(qualMsgQ, 10, 0, 10);

    const numQueues = Buffer.alloc(4);
    numQueues.writeInt32BE(1, 0);

    const replyMsgQ = Buffer.alloc(20, 0x40);

    const errorCode = Buffer.alloc(8);
    errorCode.writeInt32BE(8, 0);

    const pc = new ProgramCall(this.#system);
    pc.setProgram('/QSYS.LIB/QMHSNDM.PGM', [
      new ProgramParameter({ inputData: msgId }),
      new ProgramParameter({ inputData: qualMsgFile }),
      new ProgramParameter({ inputData: Buffer.from(msgText) }),
      new ProgramParameter({ inputData: msgDataLen }),
      new ProgramParameter({ inputData: msgType }),
      new ProgramParameter({ inputData: qualMsgQ }),
      new ProgramParameter({ inputData: numQueues }),
      new ProgramParameter({ inputData: replyMsgQ }),
      new ProgramParameter({ outputLength: 4 }),
      new ProgramParameter({ inputData: errorCode, outputLength: 8 }),
    ]);

    await pc.run();
  }
}
