/**
 * AS400 -- primary session object for IBM i host server connections.
 *
 * Upstream: AS400.java, AS400Impl*.java
 * @module core/AS400
 */

import { Trace } from './Trace.js';
import {
  Service,
  ServiceName,
  ServiceToServerID,
  DefaultPort,
  DefaultSecurePort,
} from './constants.js';
import { PortMapper } from '../transport/PortMapper.js';
import { Connection } from '../transport/Connection.js';
import { signon as signonFlow } from '../auth/signon.js';
import { changePassword as changePasswordFlow } from '../auth/change-password.js';
import {
  generateProfileToken as genProfileToken,
  signonWithToken,
} from '../auth/profile-token.js';

/**
 * Represents a connection to an IBM i system.
 *
 * Constructor shapes:
 *   new AS400()
 *   new AS400(host)
 *   new AS400(host, user, password)
 *   new AS400({ host, user, password, secure, ... })
 */
export class AS400 {
  /** @type {string} */
  #host;
  /** @type {string} */
  #user;
  /** @type {string} */
  #password;
  /** @type {boolean} */
  #secure;
  /** @type {object} */
  #tlsOptions;
  /** @type {Map<number, Connection>} per-service connection cache */
  #connections;
  /** @type {Map<number, object>} per-service server attributes */
  #serverAttributes;
  /** @type {object} */
  #ports;
  /** @type {AbortSignal|null} */
  #signal;
  /** @type {number} */
  #timeout;
  /** @type {boolean} */
  #signedOn;
  /** @type {string} */
  #currentLibrary;
  /** @type {string[]} */
  #libraryList;
  /** @type {string} */
  #iasp;
  /** @type {string} */
  #namingMode;
  /** @type {boolean} */
  #traceEnabled;

  // ---- Auth session state ----
  /** @type {number} */
  #serverVersion = 0;
  /** @type {number} */
  #serverLevel = 0;
  /** @type {number} */
  #passwordLevel = 0;
  /** @type {number} */
  #serverCCSID = 0;
  /** @type {string} */
  #signonJobName = '';
  /** @type {import('../auth/profile-token.js').ProfileToken|null} */
  #profileToken = null;
  /** @type {Function|null} */
  #signonHandler = null;

  /**
   * @param {string|object} [hostOrOpts]
   * @param {string} [user]
   * @param {string} [password]
   */
  constructor(hostOrOpts, user, password) {
    if (typeof hostOrOpts === 'object' && hostOrOpts !== null) {
      // Options object form
      const opts = hostOrOpts;
      this.#host = opts.host ?? '';
      this.#user = opts.user ?? '';
      this.#password = opts.password ?? '';
      this.#secure = opts.secure ?? false;
      this.#tlsOptions = opts.tlsOptions ?? {};
      this.#ports = opts.ports ?? {};
      this.#signal = opts.abortSignal ?? opts.signal ?? null;
      this.#timeout = opts.timeout ?? 30000;
      this.#traceEnabled = opts.trace ?? false;
      this.#signonHandler = opts.signonHandler ?? null;
    } else {
      // Positional args form
      this.#host = hostOrOpts ?? '';
      this.#user = user ?? '';
      this.#password = password ?? '';
      this.#secure = false;
      this.#tlsOptions = {};
      this.#ports = {};
      this.#signal = null;
      this.#timeout = 30000;
      this.#traceEnabled = false;
    }

    this.#connections = new Map();
    this.#serverAttributes = new Map();
    this.#signedOn = false;
    this.#currentLibrary = '';
    this.#libraryList = [];
    this.#iasp = '';
    this.#namingMode = 'system'; // 'system' or 'sql'

    if (this.#traceEnabled && !Trace.isTraceOn()) {
      Trace.setTraceOn(true);
      Trace.setTraceAllOn(true);
    }
  }

  // ---- Accessors ----

  get host()       { return this.#host; }
  set host(v)      { this.#host = v; }

  get user()       { return this.#user; }
  set user(v)      { this.#user = v; }

  get password()   { return this.#password; }
  set password(v)  { this.#password = v; }

  get secure()     { return this.#secure; }
  set secure(v)    { this.#secure = !!v; }

  get signedOn()   { return this.#signedOn; }

  get currentLibrary()  { return this.#currentLibrary; }
  set currentLibrary(v) { this.#currentLibrary = v; }

  get libraryList()     { return [...this.#libraryList]; }
  set libraryList(v)    { this.#libraryList = Array.isArray(v) ? [...v] : []; }

  get iasp()       { return this.#iasp; }
  set iasp(v)      { this.#iasp = v; }

  get namingMode() { return this.#namingMode; }
  set namingMode(v){ this.#namingMode = v; }

  /**
   * Get the service name string for a service ID.
   * @param {number} serviceId
   * @returns {string}
   */
  static getServerName(serviceId) {
    return ServiceName[serviceId] ?? 'unknown';
  }

  // ---- Auth session state accessors ----

  /** Server version from signon exchange. */
  getServerVersion() { return this.#serverVersion; }

  /** Server level from signon exchange. */
  getServerLevel() { return this.#serverLevel; }

  /** Password level (0-4) from signon exchange. */
  getPasswordLevel() { return this.#passwordLevel; }

  /** Server CCSID from signon exchange. */
  getServerCCSID() { return this.#serverCCSID; }

  /** Job name from signon. */
  getSignonJobName() { return this.#signonJobName; }

  // ---- Authentication ----

  /**
   * Authenticate to the IBM i system.
   *
   * If a profile token is set, uses token-based authentication.
   * Otherwise uses password-based authentication.
   *
   * @returns {Promise<void>}
   */
  async signon() {
    let result;

    if (this.#profileToken) {
      result = await signonWithToken(this, this.#profileToken);
    } else {
      try {
        result = await signonFlow(this);
      } catch (err) {
        // If a signon handler is set, give it a chance to handle the error
        if (this.#signonHandler && err.returnCode) {
          const info = {
            returnCode: err.returnCode,
            passwordExpired: err.returnCode === 0x00020001,
            error: err,
          };
          const action = await this.#signonHandler(info);
          if (action && action.newPassword) {
            await this.changePassword(this.#password, action.newPassword);
            this.#password = action.newPassword;
            result = await signonFlow(this);
          } else if (action && action.proceed) {
            throw err;
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }

    this.#serverVersion = result.serverVersion;
    this.#serverLevel = result.serverLevel;
    this.#passwordLevel = result.passwordLevel;
    this.#serverCCSID = result.serverCCSID ?? 0;
    this.#signonJobName = result.jobName;
    this.#signedOn = true;

    // Zero out password bytes from memory when practical
    // (JS cannot guarantee this but we do our best)
  }

  /**
   * Change the password for the current user.
   *
   * @param {string} oldPassword
   * @param {string} newPassword
   * @returns {Promise<void>}
   */
  async changePassword(oldPassword, newPassword) {
    await changePasswordFlow(this, oldPassword, newPassword);
  }

  /**
   * Generate a profile token for this session.
   *
   * @param {object} [options]
   * @param {string} [options.tokenType='multipleUseRenewable'] - 'singleUse', 'multipleUseNonRenewable', 'multipleUseRenewable'
   * @param {number} [options.timeoutInterval=3600] - Seconds
   * @returns {Promise<import('../auth/profile-token.js').ProfileToken>}
   */
  async generateProfileToken(options) {
    return genProfileToken(this, options);
  }

  /**
   * Set a profile token for token-based authentication.
   * Call signon() after setting the token to authenticate.
   *
   * @param {import('../auth/profile-token.js').ProfileToken} token
   */
  setProfileToken(token) {
    this.#profileToken = token;
  }

  /**
   * Get server info as an object (convenience).
   *
   * @returns {{ serverVersion: number, serverLevel: number, passwordLevel: number, serverCCSID: number, jobName: string }}
   */
  getServerInfo() {
    return {
      serverVersion: this.#serverVersion,
      serverLevel: this.#serverLevel,
      passwordLevel: this.#passwordLevel,
      serverCCSID: this.#serverCCSID,
      jobName: this.#signonJobName,
    };
  }

  // ---- Connection management ----

  /**
   * Connect to a specific host service.
   *
   * @param {number} serviceId - Service constant (e.g. Service.SIGNON)
   * @returns {Promise<Connection>}
   */
  async connectService(serviceId) {
    // Return cached connection if still connected
    const existing = this.#connections.get(serviceId);
    if (existing && existing.connected) {
      return existing;
    }

    const port = await this.#resolvePort(serviceId);

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `AS400.connectService: ${AS400.getServerName(serviceId)} on ${this.#host}:${port}`);
    }

    const conn = new Connection({
      host: this.#host,
      port,
      serviceId,
      secure: this.#secure,
      tlsOptions: this.#tlsOptions,
      timeout: this.#timeout,
      signal: this.#signal,
    });

    await conn.connect();
    this.#connections.set(serviceId, conn);

    if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
      Trace.log(Trace.DIAGNOSTIC,
        `AS400.connectService: connected to ${AS400.getServerName(serviceId)}`);
    }

    return conn;
  }

  /**
   * Disconnect a specific service.
   * @param {number} serviceId
   */
  disconnectService(serviceId) {
    const conn = this.#connections.get(serviceId);
    if (conn) {
      conn.close();
      this.#connections.delete(serviceId);
    }
  }

  /**
   * Check if a service is currently connected.
   * @param {number} serviceId
   * @returns {boolean}
   */
  isServiceConnected(serviceId) {
    const conn = this.#connections.get(serviceId);
    return conn?.connected ?? false;
  }

  /**
   * Get the connection for a service (if connected).
   * @param {number} serviceId
   * @returns {Connection|null}
   */
  getConnection(serviceId) {
    return this.#connections.get(serviceId) ?? null;
  }

  /**
   * Get cached server attributes for a service.
   * @param {number} serviceId
   * @returns {object|null}
   */
  getServerAttributes(serviceId) {
    return this.#serverAttributes.get(serviceId) ?? null;
  }

  /**
   * Store server attributes for a service.
   * @param {number} serviceId
   * @param {object} attrs
   */
  setServerAttributes(serviceId, attrs) {
    this.#serverAttributes.set(serviceId, attrs);
  }

  /**
   * Close all connections.
   */
  async close() {
    for (const [serviceId, conn] of this.#connections) {
      if (Trace.isTraceOn() && Trace.isTraceDiagnosticOn()) {
        Trace.log(Trace.DIAGNOSTIC,
          `AS400.close: disconnecting ${AS400.getServerName(serviceId)}`);
      }
      conn.close();
    }
    this.#connections.clear();
    this.#serverAttributes.clear();
    this.#signedOn = false;
  }

  // ---- IFS convenience ----

  /**
   * Return a convenience IFS API bound to this system.
   *
   * Usage:
   *   const fs = system.ifs();
   *   await fs.readFile('/home/myuser/test.txt');
   *   await fs.writeFile('/tmp/out.bin', buffer);
   *   const names = await fs.readdir('/home/myuser');
   *   const info = await fs.stat('/home/myuser/test.txt');
   *   await fs.mkdir('/tmp/newdir');
   *   await fs.unlink('/tmp/old.txt');
   *   await fs.rename('/tmp/a.txt', '/tmp/b.txt');
   *   await fs.copyFile('/tmp/a.txt', '/tmp/b.txt');
   *
   * @returns {object}
   */
  ifs() {
    const sys = this;
    return {
      async readFile(path, opts = {}) {
        const { IFSFileInputStream } = await import('../ifs/IFSFileInputStream.js');
        const stream = new IFSFileInputStream(sys, path, opts);
        try {
          return await stream.readAll();
        } finally {
          await stream.close();
        }
      },
      async readTextFile(path, opts = {}) {
        const { IFSTextFileInputStream } = await import('../ifs/IFSTextFileInputStream.js');
        const stream = new IFSTextFileInputStream(sys, path, opts);
        try {
          return await stream.readAll();
        } finally {
          await stream.close();
        }
      },
      async writeFile(path, data, opts = {}) {
        const { IFSFileOutputStream } = await import('../ifs/IFSFileOutputStream.js');
        const stream = new IFSFileOutputStream(sys, path, opts);
        try {
          await stream.write(typeof data === 'string' ? Buffer.from(data) : data);
        } finally {
          await stream.close();
        }
      },
      async writeTextFile(path, text, opts = {}) {
        const { IFSTextFileOutputStream } = await import('../ifs/IFSTextFileOutputStream.js');
        const stream = new IFSTextFileOutputStream(sys, path, opts);
        try {
          await stream.write(text);
        } finally {
          await stream.close();
        }
      },
      async stat(path) {
        const { IFSFile } = await import('../ifs/IFSFile.js');
        const f = new IFSFile(sys, path);
        const [exists, isDir, isFile, size, modified, created] = await Promise.all([
          f.exists(), f.isDirectory(), f.isFile(),
          f.length(), f.lastModified(), f.created(),
        ]);
        return { exists, isDirectory: isDir, isFile, size, modified, created, path };
      },
      async readdir(path, filter) {
        const { IFSFile } = await import('../ifs/IFSFile.js');
        const dir = new IFSFile(sys, path);
        return dir.list(filter);
      },
      async readdirDetail(path, filter) {
        const { IFSFile } = await import('../ifs/IFSFile.js');
        const dir = new IFSFile(sys, path);
        return dir.listFiles(filter);
      },
      async mkdir(path) {
        const { IFSFile } = await import('../ifs/IFSFile.js');
        const dir = new IFSFile(sys, path);
        return dir.mkdir();
      },
      async mkdirs(path) {
        const { IFSFile } = await import('../ifs/IFSFile.js');
        const dir = new IFSFile(sys, path);
        return dir.mkdirs();
      },
      async unlink(path) {
        const { IFSFile } = await import('../ifs/IFSFile.js');
        const f = new IFSFile(sys, path);
        return f.delete();
      },
      async rename(src, dst) {
        const { IFSFile } = await import('../ifs/IFSFile.js');
        const f = new IFSFile(sys, src);
        return f.renameTo(dst);
      },
      async copyFile(src, dst, opts = {}) {
        const { IFSFile } = await import('../ifs/IFSFile.js');
        const f = new IFSFile(sys, src);
        return f.copyTo(dst, opts);
      },
    };
  }

  // ---- Command / Program convenience ----

  /**
   * Run a CL command and return the message list.
   *
   * @param {string} command - CL command string
   * @returns {Promise<import('./AS400Message.js').AS400Message[]>}
   */
  async runCommand(command) {
    const { CommandCall } = await import('../command/CommandCall.js');
    const cmd = new CommandCall(this);
    await cmd.run(command);
    return cmd.getMessageList();
  }

  /**
   * Call a program with typed shorthand parameters.
   *
   * @param {object} opts
   * @param {string} opts.program - IFS path or lib/pgm name
   * @param {Array<object>} [opts.parameters] - Parameter descriptors
   * @returns {Promise<{ success: boolean, parameters: Array<{ value: * }>, messages: Array }>}
   */
  async callProgram(opts) {
    const { ProgramCall } = await import('../command/ProgramCall.js');
    const { ProgramParameter } = await import('../command/ProgramParameter.js');
    const { resolvePcmlType } = await import('../pcml/types.js');

    const params = [];
    const paramDescs = opts.parameters ?? [];

    for (const desc of paramDescs) {
      const type = desc.type ?? 'char';
      const length = desc.length ?? 10;
      const ccsid = desc.ccsid ?? 37;
      const precision = desc.precision ?? 0;
      const usage = desc.usage ?? 'input';

      const dt = resolvePcmlType({ type, length, precision, ccsid });
      const byteLen = dt.byteLength();

      const isInput = usage === 'input' || usage === 'inputOutput';
      const isOutput = usage === 'output' || usage === 'inputOutput';

      let inputData = null;
      if (isInput && desc.value != null) {
        inputData = dt.toBuffer(desc.value);
      } else if (isInput) {
        inputData = Buffer.alloc(byteLen);
      }

      const outputLen = isOutput ? byteLen : 0;

      params.push(new ProgramParameter({
        inputData,
        outputLength: outputLen,
        usage: usage === 'input' ? ProgramParameter.INPUT
             : usage === 'output' ? ProgramParameter.OUTPUT
             : ProgramParameter.INOUT,
      }));
    }

    const pc = new ProgramCall(this);
    pc.setProgram(opts.program, params);
    const success = await pc.run();

    // Decode output parameters
    const result = {
      success,
      parameters: [],
      messages: pc.getMessageList(),
    };

    for (let i = 0; i < paramDescs.length; i++) {
      const desc = paramDescs[i];
      const p = params[i];
      const usage = desc.usage ?? 'input';

      if (usage === 'output' || usage === 'inputOutput') {
        const outBuf = p.getOutputData();
        if (outBuf && outBuf.length > 0) {
          const dt = resolvePcmlType({
            type: desc.type ?? 'char',
            length: desc.length ?? 10,
            precision: desc.precision ?? 0,
            ccsid: desc.ccsid ?? 37,
          });
          try {
            let val = dt.fromBuffer(outBuf, 0);
            if (desc.trim && typeof val === 'string') val = val.trim();
            result.parameters.push({ value: val });
          } catch {
            result.parameters.push({ value: outBuf });
          }
        } else {
          result.parameters.push({ value: null });
        }
      } else {
        result.parameters.push({ value: desc.value ?? null });
      }
    }

    return result;
  }

  // ---- Internal ----

  /**
   * Resolve the port for a service, using overrides, port mapper, or defaults.
   * @param {number} serviceId
   * @returns {Promise<number>}
   */
  async #resolvePort(serviceId) {
    // Check explicit port override
    const override = this.#ports[serviceId];
    if (override && override > 0) {
      return override;
    }

    // Try port mapper
    try {
      return await PortMapper.resolvePort(this.#host, serviceId, {
        secure: this.#secure,
        timeout: Math.min(this.#timeout, 10000),
        signal: this.#signal,
      });
    } catch {
      // Fall back to defaults
      const defaults = this.#secure ? DefaultSecurePort : DefaultPort;
      return defaults[serviceId] ?? 0;
    }
  }
}
