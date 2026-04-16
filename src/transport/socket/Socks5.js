/**
 * SOCKS5 tunnel support.
 *
 * Implements RFC 1928 SOCKS5 handshake to tunnel TCP connections
 * through a SOCKS5 proxy server.
 *
 * Upstream: com.ibm.as400.socket.Sock5Socket
 * @module transport/socket/Socks5
 */

import net from 'node:net';
import { Trace } from '../../core/Trace.js';
import { ConnectionDroppedError } from '../../core/errors.js';

/* SOCKS5 constants (RFC 1928) */
const VER = 0x05;
const METHOD_NO_AUTH = 0x00;
const METHOD_USER_PASS = 0x02;
const METHOD_NO_ACCEPTABLE = 0xFF;
const CMD_CONNECT = 0x01;
const RSV = 0x00;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;

/* Sub-negotiation for username/password (RFC 1929) */
const AUTH_VER = 0x01;

export class Socks5 {

  /**
   * Create a TCP connection through a SOCKS5 proxy.
   *
   * @param {object} opts
   * @param {string} opts.proxyHost      - SOCKS5 proxy hostname
   * @param {number} opts.proxyPort      - SOCKS5 proxy port
   * @param {string} opts.targetHost     - Destination hostname
   * @param {number} opts.targetPort     - Destination port
   * @param {string} [opts.proxyUser]    - Proxy username (for auth)
   * @param {string} [opts.proxyPassword]- Proxy password (for auth)
   * @param {number} [opts.timeout=30000]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<net.Socket>} Connected socket tunneled through the proxy
   */
  static async connect(opts) {
    const {
      proxyHost,
      proxyPort,
      targetHost,
      targetPort,
      proxyUser,
      proxyPassword,
      timeout = 30000,
      signal,
    } = opts;

    const useAuth = !!(proxyUser && proxyPassword);

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `SOCKS5: connecting via ${proxyHost}:${proxyPort} to ${targetHost}:${targetPort}`);
    }

    const socket = await Socks5.#connectProxy(proxyHost, proxyPort, timeout, signal);

    try {
      // Step 1: greeting
      await Socks5.#sendGreeting(socket, useAuth);
      const method = await Socks5.#receiveGreetingReply(socket);

      // Step 2: authentication if required
      if (method === METHOD_USER_PASS) {
        if (!useAuth) {
          throw new ConnectionDroppedError('SOCKS5 proxy requires authentication but no credentials provided');
        }
        await Socks5.#sendAuth(socket, proxyUser, proxyPassword);
        await Socks5.#receiveAuthReply(socket);
      } else if (method !== METHOD_NO_AUTH) {
        throw new ConnectionDroppedError(`SOCKS5 proxy returned unsupported method: 0x${method.toString(16)}`);
      }

      // Step 3: connect request
      await Socks5.#sendConnectRequest(socket, targetHost, targetPort);
      await Socks5.#receiveConnectReply(socket);

      if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
        Trace.log(Trace.DIAGNOSTIC, 'SOCKS5: tunnel established');
      }

      return socket;
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  /**
   * Build a SOCKS5 greeting buffer.
   * @param {boolean} useAuth
   * @returns {Buffer}
   */
  static buildGreeting(useAuth) {
    if (useAuth) {
      return Buffer.from([VER, 0x02, METHOD_NO_AUTH, METHOD_USER_PASS]);
    }
    return Buffer.from([VER, 0x01, METHOD_NO_AUTH]);
  }

  /**
   * Build a SOCKS5 CONNECT request buffer.
   * @param {string} host
   * @param {number} port
   * @returns {Buffer}
   */
  static buildConnectRequest(host, port) {
    // Use domain name addressing
    const hostBuf = Buffer.from(host, 'ascii');
    const buf = Buffer.alloc(4 + 1 + hostBuf.length + 2);
    buf[0] = VER;
    buf[1] = CMD_CONNECT;
    buf[2] = RSV;
    buf[3] = ATYP_DOMAIN;
    buf[4] = hostBuf.length;
    hostBuf.copy(buf, 5);
    buf.writeUInt16BE(port, 5 + hostBuf.length);
    return buf;
  }

  /**
   * Parse a SOCKS5 greeting reply.
   * @param {Buffer} data - At least 2 bytes
   * @returns {{ version: number, method: number }}
   */
  static parseGreetingReply(data) {
    if (!data || data.length < 2) {
      throw new ConnectionDroppedError('SOCKS5 greeting reply too short');
    }
    return { version: data[0], method: data[1] };
  }

  /**
   * Parse a SOCKS5 connect reply.
   * @param {Buffer} data
   * @returns {{ version: number, reply: number, addressType: number }}
   */
  static parseConnectReply(data) {
    if (!data || data.length < 4) {
      throw new ConnectionDroppedError('SOCKS5 connect reply too short');
    }
    return { version: data[0], reply: data[1], addressType: data[3] };
  }

  // ---- Internal ----

  static #connectProxy(proxyHost, proxyPort, timeout, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {net.Socket|null} */
      let socket = null;
      const done = (err, sock) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) {
          if (sock) sock.destroy();
          reject(err);
        } else {
          resolve(sock);
        }
      };

      const timer = setTimeout(() => {
        done(new ConnectionDroppedError(`SOCKS5 proxy connect timeout after ${timeout}ms`), socket);
      }, timeout);

      const onAbort = () => {
        done(new ConnectionDroppedError('SOCKS5 connect aborted'), socket);
      };
      if (signal) {
        if (signal.aborted) { done(new ConnectionDroppedError('SOCKS5 connect aborted'), socket); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      socket = net.createConnection({ host: proxyHost, port: proxyPort }, () => {
        done(null, socket);
      });
      socket.on('error', (err) => {
        done(new ConnectionDroppedError(`SOCKS5 proxy connection error: ${err.message}`, { cause: err }));
      });
    });
  }

  static #sendGreeting(socket, useAuth) {
    const buf = Socks5.buildGreeting(useAuth);
    return new Promise((resolve, reject) => {
      socket.write(buf, (err) => {
        if (err) reject(new ConnectionDroppedError('SOCKS5 greeting write failed'));
        else resolve();
      });
    });
  }

  static #receiveGreetingReply(socket) {
    return Socks5.#readBytes(socket, 2).then(data => {
      const { version, method } = Socks5.parseGreetingReply(data);
      if (version !== VER) {
        throw new ConnectionDroppedError(`SOCKS5 unexpected version: ${version}`);
      }
      if (method === METHOD_NO_ACCEPTABLE) {
        throw new ConnectionDroppedError('SOCKS5 proxy: no acceptable authentication method');
      }
      return method;
    });
  }

  static #sendAuth(socket, user, pass) {
    const userBuf = Buffer.from(user, 'utf8');
    const passBuf = Buffer.from(pass, 'utf8');
    const buf = Buffer.alloc(3 + userBuf.length + passBuf.length);
    buf[0] = AUTH_VER;
    buf[1] = userBuf.length;
    userBuf.copy(buf, 2);
    buf[2 + userBuf.length] = passBuf.length;
    passBuf.copy(buf, 3 + userBuf.length);
    return new Promise((resolve, reject) => {
      socket.write(buf, (err) => {
        if (err) reject(new ConnectionDroppedError('SOCKS5 auth write failed'));
        else resolve();
      });
    });
  }

  static #receiveAuthReply(socket) {
    return Socks5.#readBytes(socket, 2).then(data => {
      if (data[1] !== 0x00) {
        throw new ConnectionDroppedError('SOCKS5 authentication failed');
      }
    });
  }

  static #sendConnectRequest(socket, host, port) {
    const buf = Socks5.buildConnectRequest(host, port);
    return new Promise((resolve, reject) => {
      socket.write(buf, (err) => {
        if (err) reject(new ConnectionDroppedError('SOCKS5 connect request write failed'));
        else resolve();
      });
    });
  }

  static #receiveConnectReply(socket) {
    // Read initial 4 bytes first
    return Socks5.#readBytes(socket, 4).then(async (header) => {
      if (header[0] !== VER) {
        throw new ConnectionDroppedError(`SOCKS5 unexpected version in reply: ${header[0]}`);
      }
      if (header[1] !== REP_SUCCESS) {
        throw new ConnectionDroppedError(`SOCKS5 connect failed with reply code: 0x${header[1].toString(16)}`);
      }

      // Read the bound address based on address type
      const atyp = header[3];
      let remaining;
      if (atyp === ATYP_IPV4) {
        remaining = 4 + 2; // 4 bytes IP + 2 bytes port
      } else if (atyp === ATYP_IPV6) {
        remaining = 16 + 2;
      } else if (atyp === ATYP_DOMAIN) {
        const lenBuf = await Socks5.#readBytes(socket, 1);
        remaining = lenBuf[0] + 2;
      } else {
        throw new ConnectionDroppedError(`SOCKS5 unsupported address type: ${atyp}`);
      }

      // Drain the remaining bytes
      await Socks5.#readBytes(socket, remaining);
    });
  }

  static #readBytes(socket, n) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let got = 0;

      const tryRead = () => {
        while (got < n) {
          const chunk = socket.read(n - got);
          if (!chunk) break;
          chunks.push(chunk);
          got += chunk.length;
        }
        if (got >= n) {
          cleanup();
          resolve(Buffer.concat(chunks, n));
        }
      };

      const onReadable = () => tryRead();
      const onError = (err) => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); reject(new ConnectionDroppedError('Socket closed during SOCKS5 handshake')); };

      const cleanup = () => {
        socket.removeListener('readable', onReadable);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      };

      socket.on('readable', onReadable);
      socket.on('error', onError);
      socket.on('close', onClose);
      tryRead();
    });
  }
}
