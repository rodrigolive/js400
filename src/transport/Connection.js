/**
 * TCP/TLS connection wrapper and framing entry point.
 *
 * Provides connect/send/receive/close over node:net (TCP) or node:tls (TLS).
 * Frame-based reading uses the DataStream header to know total length.
 *
 * Upstream: AS400Server.java, AS400ThreadedServer.java, AS400NoThreadServer.java
 * @module transport/Connection
 */

import net from 'node:net';
import tls from 'node:tls';
import { Trace } from '../core/Trace.js';
import { ConnectionDroppedError } from '../core/errors.js';
import { DataStream } from './DataStream.js';

/**
 * A connection to a single IBM i host-server job.
 */
export class Connection {
  /** @type {net.Socket|tls.TLSSocket|null} */
  #socket = null;
  /** @type {string} */
  #host;
  /** @type {number} */
  #port;
  /** @type {boolean} */
  #secure;
  /** @type {number} */
  #serviceId;
  /** @type {number} */
  #connectionId;
  /** @type {boolean} */
  #connected = false;
  /** @type {string|null} */
  #jobString = null;

  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {number} opts.serviceId
   * @param {boolean} [opts.secure=false]
   * @param {object}  [opts.tlsOptions]   - Extra tls.connect options
   * @param {number}  [opts.timeout=30000]
   * @param {AbortSignal} [opts.signal]
   */
  constructor(opts) {
    this.#host = opts.host;
    this.#port = opts.port;
    this.#serviceId = opts.serviceId;
    this.#secure = opts.secure ?? false;
    this.#connectionId = Connection.#nextConnId++;
    this._timeout = opts.timeout ?? 30000;
    this._tlsOptions = opts.tlsOptions ?? {};
    this._signal = opts.signal ?? null;
  }

  static #nextConnId = 1;

  get host()         { return this.#host; }
  get port()         { return this.#port; }
  get serviceId()    { return this.#serviceId; }
  get connectionId() { return this.#connectionId; }
  get connected()    { return this.#connected; }
  get jobString()    { return this.#jobString; }
  set jobString(v)   { this.#jobString = v; }

  /**
   * Open the TCP or TLS connection.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.#connected) return;

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `Connecting to ${this.#host}:${this.#port} (service=${this.#serviceId}, secure=${this.#secure}, connID=${this.#connectionId})`);
    }

    const socket = await this.#createSocket();
    this.#socket = socket;
    this.#connected = true;

    socket.on('error', (err) => {
      if (Trace.isTraceOn() && Trace.isTraceErrorOn()) {
        Trace.log(Trace.ERROR, `Socket error (connID=${this.#connectionId})`, err);
      }
      this.#connected = false;
    });

    socket.on('close', () => {
      this.#connected = false;
    });

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `Connected (connID=${this.#connectionId}) local=${socket.localAddress}:${socket.localPort}`);
    }
  }

  /**
   * Send a buffer over the connection.
   * @param {Buffer} data
   * @returns {Promise<void>}
   */
  async send(data) {
    if (!this.#socket || !this.#connected) {
      throw new ConnectionDroppedError('Not connected');
    }

    if (Trace.isTraceOn() && Trace.isTraceDatastreamOn()) {
      Trace.logHex(Trace.DATASTREAM, `Send (connID=${this.#connectionId})`, data);
    }

    return new Promise((resolve, reject) => {
      this.#socket.write(data, (err) => {
        if (err) reject(new ConnectionDroppedError(`Write failed: ${err.message}`, { cause: err }));
        else resolve();
      });
    });
  }

  /**
   * Receive a complete datastream frame.
   * Reads the 20-byte header, extracts total length, reads remainder.
   *
   * @returns {Promise<Buffer>}
   */
  async receive() {
    if (!this.#socket || !this.#connected) {
      throw new ConnectionDroppedError('Not connected');
    }
    return DataStream.readFrame(this.#socket);
  }

  /**
   * Send a request and wait for a correlated reply.
   *
   * @param {Buffer} request - Full datastream to send
   * @returns {Promise<Buffer>} Reply datastream
   */
  async sendAndReceive(request) {
    await this.send(request);
    return this.receive();
  }

  /**
   * Close the connection.
   */
  close() {
    if (this.#socket) {
      this.#socket.destroy();
      this.#socket = null;
    }
    this.#connected = false;
  }

  // ---- Internal ----

  /**
   * @returns {Promise<net.Socket|tls.TLSSocket>}
   */
  #createSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {net.Socket|tls.TLSSocket|null} */
      let socket = null;
      const done = (err, sock) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._signal) this._signal.removeEventListener('abort', onAbort);
        if (err) {
          if (sock) sock.destroy();
          reject(err);
        } else {
          resolve(sock);
        }
      };

      const timer = setTimeout(() => {
        done(new ConnectionDroppedError(`Connection timeout after ${this._timeout}ms`), socket);
      }, this._timeout);

      const onAbort = () => {
        done(new ConnectionDroppedError('Connection aborted'), socket);
      };
      if (this._signal) {
        if (this._signal.aborted) { done(new ConnectionDroppedError('Connection aborted'), socket); return; }
        this._signal.addEventListener('abort', onAbort, { once: true });
      }

      if (this.#secure) {
        socket = tls.connect({
          host: this.#host,
          port: this.#port,
          ...this._tlsOptions,
        }, () => {
          done(null, socket);
        });
      } else {
        socket = net.createConnection({
          host: this.#host,
          port: this.#port,
        }, () => {
          done(null, socket);
        });
      }

      socket.on('error', (err) => {
        done(new ConnectionDroppedError(`Socket connect error: ${err.message}`, { cause: err }));
      });
    });
  }
}
