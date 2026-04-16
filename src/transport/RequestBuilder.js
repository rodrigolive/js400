/**
 * Generic request buffer construction helpers.
 *
 * Builds request buffers with the 20-byte Client Access header plus
 * template and optional LL/CP data items.
 *
 * Upstream: various *Req.java classes
 * @module transport/RequestBuilder
 */

import { DataStream } from './DataStream.js';
import { Trace } from '../core/Trace.js';

/**
 * Fluent builder for constructing IBM i host server request datastreams.
 *
 * Usage:
 *   const buf = new RequestBuilder(serverId, reqRepId)
 *     .setTemplateLen(4)
 *     .writeTemplate(templateBuf)
 *     .addLLCP(0x1105, passwordBuf)
 *     .addLLCP(0x1104, userIdBuf)
 *     .build();
 */
export class RequestBuilder {
  #serverId;
  #reqRepId;
  #headerID;
  #csInstance;
  #correlation;
  #templateLen;
  #templateData;
  #llcpItems;

  /**
   * @param {number} serverId
   * @param {number} reqRepId
   */
  constructor(serverId, reqRepId) {
    this.#serverId = serverId;
    this.#reqRepId = reqRepId;
    this.#headerID = 0;
    this.#csInstance = 0;
    this.#correlation = DataStream.nextCorrelation();
    this.#templateLen = 0;
    this.#templateData = null;
    this.#llcpItems = [];
  }

  /**
   * Set the header ID / client attributes.
   * @param {number} id
   * @returns {this}
   */
  setHeaderID(id) {
    this.#headerID = id;
    return this;
  }

  /**
   * Set CS instance.
   * @param {number} id
   * @returns {this}
   */
  setCSInstance(id) {
    this.#csInstance = id;
    return this;
  }

  /**
   * Set correlation ID.
   * @param {number} id
   * @returns {this}
   */
  setCorrelation(id) {
    this.#correlation = id;
    return this;
  }

  /**
   * Set template length.
   * @param {number} len
   * @returns {this}
   */
  setTemplateLen(len) {
    this.#templateLen = len;
    return this;
  }

  /**
   * Write template data (bytes after header, before LL/CP items).
   * @param {Buffer} data
   * @returns {this}
   */
  writeTemplate(data) {
    this.#templateData = data;
    this.#templateLen = data.length;
    return this;
  }

  /**
   * Add an LL/CP data item.
   *
   * Format: LL (4 bytes) + CP (2 bytes) + data
   * LL = 6 + data.length
   *
   * @param {number} codePoint
   * @param {Buffer} data
   * @returns {this}
   */
  addLLCP(codePoint, data) {
    this.#llcpItems.push({ cp: codePoint, data });
    return this;
  }

  /**
   * Add an LL/CP data item with a CCSID prefix.
   *
   * Format: LL (4 bytes) + CP (2 bytes) + CCSID (4 bytes) + data
   * LL = 10 + data.length
   *
   * @param {number} codePoint
   * @param {number} ccsid
   * @param {Buffer} data
   * @returns {this}
   */
  addLLCPWithCCSID(codePoint, ccsid, data) {
    const combined = Buffer.alloc(4 + data.length);
    combined.writeUInt32BE(ccsid, 0);
    data.copy(combined, 4);
    this.#llcpItems.push({ cp: codePoint, data: combined });
    return this;
  }

  /**
   * Build the complete datastream buffer.
   * @returns {Buffer}
   */
  build() {
    // Calculate total LL/CP payload size
    let llcpSize = 0;
    for (const item of this.#llcpItems) {
      llcpSize += 6 + item.data.length; // LL(4) + CP(2) + data
    }

    const totalLength = DataStream.HEADER_LENGTH + this.#templateLen + llcpSize;
    const buf = Buffer.alloc(totalLength);

    // Write header
    buf.writeUInt32BE(totalLength, 0);
    buf.writeUInt16BE(this.#headerID, 4);
    buf.writeUInt16BE(this.#serverId, 6);
    buf.writeUInt32BE(this.#csInstance >>> 0, 8);
    buf.writeUInt32BE(this.#correlation >>> 0, 12);
    buf.writeUInt16BE(this.#templateLen, 16);
    buf.writeUInt16BE(this.#reqRepId, 18);

    // Write template data
    let offset = DataStream.HEADER_LENGTH;
    if (this.#templateData) {
      this.#templateData.copy(buf, offset, 0, this.#templateLen);
    }
    offset += this.#templateLen;

    // Write LL/CP items
    for (const item of this.#llcpItems) {
      const ll = 6 + item.data.length;
      buf.writeUInt32BE(ll, offset);
      buf.writeUInt16BE(item.cp, offset + 4);
      item.data.copy(buf, offset + 6);
      offset += ll;
    }

    if (Trace.isTraceOn() && Trace.isTraceDatastreamOn()) {
      Trace.logHex(Trace.DATASTREAM, `Request built (reqRepId=0x${this.#reqRepId.toString(16)})`, buf);
    }

    return buf;
  }

  /**
   * Get the correlation ID that will be used.
   * @returns {number}
   */
  get correlation() {
    return this.#correlation;
  }
}
