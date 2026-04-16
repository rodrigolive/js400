/**
 * Service connectivity probe.
 *
 * Tests TCP connectivity to each IBM i host server port to determine
 * which services are reachable.
 *
 * Upstream: AS400JPing.java, JPing.java
 * @module objects/JPing
 */

import net from 'node:net';
import { Service, DefaultPort, DefaultSecurePort, ServiceName } from '../core/constants.js';
import { PortMapper } from '../transport/PortMapper.js';

/**
 * Service connectivity probe for IBM i host servers.
 */
export class JPing {
  #host;
  #timeout;
  #secure;

  /**
   * @param {string} host - IBM i hostname or IP address
   * @param {object} [opts]
   * @param {number} [opts.timeout=5000] - Connection timeout in ms
   * @param {boolean} [opts.secure=false] - Use TLS ports
   */
  constructor(host, opts = {}) {
    if (!host) throw new Error('JPing requires a host');
    this.#host = host;
    this.#timeout = opts.timeout ?? 5000;
    this.#secure = opts.secure ?? false;
  }

  /**
   * Ping all host server services.
   * @returns {Promise<Record<string, boolean>>} Map of service name to reachability
   */
  async pingAllServices() {
    const results = {};
    const services = [
      Service.FILE,
      Service.PRINT,
      Service.COMMAND,
      Service.DATAQUEUE,
      Service.DATABASE,
      Service.RECORDACCESS,
      Service.CENTRAL,
      Service.SIGNON,
    ];

    const promises = services.map(async (serviceId) => {
      const name = ServiceName[serviceId] ?? `service-${serviceId}`;
      results[name] = await this.ping(serviceId);
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Ping a specific service.
   * @param {number} serviceId - Service constant
   * @returns {Promise<boolean>}
   */
  async ping(serviceId) {
    let port;
    try {
      port = await PortMapper.resolvePort(this.#host, serviceId, {
        secure: this.#secure,
        timeout: Math.min(this.#timeout, 5000),
      });
    } catch {
      const defaults = this.#secure ? DefaultSecurePort : DefaultPort;
      port = defaults[serviceId];
    }

    if (!port || port <= 0) return false;

    return this.#tryConnect(port);
  }

  /**
   * Try a TCP connection to a specific port.
   * @param {number} port
   * @returns {Promise<boolean>}
   */
  async #tryConnect(port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const done = (ok) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };

      socket.setTimeout(this.#timeout);
      socket.on('connect', () => done(true));
      socket.on('error', () => done(false));
      socket.on('timeout', () => done(false));
      socket.connect(port, this.#host);
    });
  }
}
