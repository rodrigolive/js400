/**
 * Port-mapper client.
 *
 * Connects to port 449 on an IBM i host and resolves the actual port
 * for a given service. The protocol:
 *   1. Connect TCP to host:449
 *   2. Send the ASCII service name (e.g. "as-signon" or "as-signon-s")
 *   3. Read 5 bytes: ['+' or '-'] + 4-byte big-endian port number
 *
 * Upstream: PortMapper.java, AS400PortMapDS.java, AS400PortMapReplyDS.java
 * @module transport/PortMapper
 */

import net from 'node:net';
import { Trace } from '../core/Trace.js';
import {
  Service,
  ServiceName,
  DefaultPort,
  DefaultSecurePort,
  PORT_MAPPER_PORT,
} from '../core/constants.js';
import { ConnectionDroppedError } from '../core/errors.js';

/** Cache of resolved ports: Map<"host:service:secure", number> */
const portCache = new Map();

export class PortMapper {

  /**
   * Resolve the port for a given service on the specified host.
   *
   * @param {string} host       - IBM i hostname or IP
   * @param {number} serviceId  - Service constant (e.g. Service.SIGNON)
   * @param {object} [opts]
   * @param {boolean} [opts.secure=false] - Use TLS service name variant
   * @param {number}  [opts.timeout=10000] - Timeout in ms
   * @param {AbortSignal} [opts.signal] - AbortSignal for cancellation
   * @returns {Promise<number>} Resolved port number
   */
  static async resolvePort(host, serviceId, opts = {}) {
    const { secure = false, timeout = 10000, signal } = opts;

    // Check cache
    const cacheKey = `${host}:${serviceId}:${secure ? 1 : 0}`;
    const cached = portCache.get(cacheKey);
    if (cached) return cached;

    // Build service name string
    const baseName = ServiceName[serviceId];
    if (!baseName) {
      throw new Error(`Unknown service ID: ${serviceId}`);
    }

    // For secure, append "-s". Host connection server is always "-s".
    let serviceName = baseName;
    if (secure || serviceId === Service.HOSTCNN) {
      serviceName += '-s';
    }

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC, `Port mapper: resolving ${serviceName} on ${host}`);
    }

    try {
      const port = await PortMapper.#query(host, serviceName, timeout, signal);
      portCache.set(cacheKey, port);

      if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
        Trace.log(Trace.DIAGNOSTIC, `Port mapper: ${serviceName} => ${port}`);
      }

      return port;
    } catch (err) {
      // Fallback to default ports
      if (Trace.isTraceOn() && Trace.isTraceWarningOn()) {
        Trace.log(Trace.WARNING, `Port mapper failed, using default port for service ${serviceId}`, err);
      }
      const defaultPort = secure ? DefaultSecurePort[serviceId] : DefaultPort[serviceId];
      if (defaultPort && defaultPort > 0) {
        portCache.set(cacheKey, defaultPort);
        return defaultPort;
      }
      throw err;
    }
  }

  /**
   * Perform the actual port mapper query over TCP.
   * @param {string} host
   * @param {string} serviceName
   * @param {number} timeout
   * @param {AbortSignal} [signal]
   * @returns {Promise<number>}
   */
  static #query(host, serviceName, timeout, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, port) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(port);
      };

      const socket = net.createConnection({ host, port: PORT_MAPPER_PORT });

      const timer = setTimeout(() => {
        done(new ConnectionDroppedError(`Port mapper timeout after ${timeout}ms`));
      }, timeout);

      const onAbort = () => {
        done(new ConnectionDroppedError('Port mapper aborted'));
      };
      if (signal) {
        if (signal.aborted) { done(new ConnectionDroppedError('Port mapper aborted')); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      socket.on('connect', () => {
        // Send service name as ASCII bytes
        const data = Buffer.from(serviceName, 'ascii');
        socket.write(data);

        if (Trace.isTraceOn() && Trace.isTraceDatastreamOn()) {
          Trace.logHex(Trace.DATASTREAM, 'Port mapper request', data);
        }
      });

      const chunks = [];
      let totalLen = 0;

      socket.on('data', (chunk) => {
        chunks.push(chunk);
        totalLen += chunk.length;
        if (totalLen >= 5) {
          const reply = Buffer.concat(chunks);

          if (Trace.isTraceOn() && Trace.isTraceDatastreamOn()) {
            Trace.logHex(Trace.DATASTREAM, 'Port mapper reply', reply);
          }

          // First byte: 0x2B ('+') means success
          if (reply[0] === 0x2B) {
            const port = reply.readUInt32BE(1);
            done(null, port);
          } else {
            done(new ConnectionDroppedError('Port mapper returned negative response'));
          }
        }
      });

      socket.on('error', (err) => {
        done(new ConnectionDroppedError(`Port mapper connection error: ${err.message}`, { cause: err }));
      });

      socket.on('close', () => {
        done(new ConnectionDroppedError('Port mapper connection closed before reply'));
      });
    });
  }

  /**
   * Parse a 5-byte port mapper reply buffer.
   * @param {Buffer} reply - 5-byte buffer
   * @returns {{ success: boolean, port: number }}
   */
  static parseReply(reply) {
    if (!reply || reply.length < 5) {
      return { success: false, port: 0 };
    }
    const success = reply[0] === 0x2B; // '+'
    const port = reply.readUInt32BE(1);
    return { success, port };
  }

  /**
   * Build a port mapper request buffer from a service name string.
   * @param {string} serviceName
   * @returns {Buffer}
   */
  static buildRequest(serviceName) {
    return Buffer.from(serviceName, 'ascii');
  }

  /**
   * Clear the resolved port cache.
   */
  static clearCache() {
    portCache.clear();
  }

  /**
   * Get the default port for a service.
   * @param {number} serviceId
   * @param {boolean} [secure=false]
   * @returns {number}
   */
  static getDefaultPort(serviceId, secure = false) {
    return secure ? (DefaultSecurePort[serviceId] ?? 0) : (DefaultPort[serviceId] ?? 0);
  }
}
