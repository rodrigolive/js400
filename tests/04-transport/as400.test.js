/**
 * AS400 constructor variants, service cache, and configuration tests.
 */
import { describe, test, expect } from 'bun:test';
import { AS400 } from '../../src/core/AS400.js';
import { Service, ServiceName } from '../../src/core/constants.js';

describe('AS400', () => {
  test('default constructor (no args)', () => {
    const sys = new AS400();
    expect(sys.host).toBe('');
    expect(sys.user).toBe('');
    expect(sys.password).toBe('');
    expect(sys.secure).toBe(false);
    expect(sys.signedOn).toBe(false);
  });

  test('constructor with host only', () => {
    const sys = new AS400('myhost.example.com');
    expect(sys.host).toBe('myhost.example.com');
    expect(sys.user).toBe('');
    expect(sys.password).toBe('');
  });

  test('constructor with host, user, password', () => {
    const sys = new AS400('myhost', 'MYUSER', 'MYPASS');
    expect(sys.host).toBe('myhost');
    expect(sys.user).toBe('MYUSER');
    expect(sys.password).toBe('MYPASS');
    expect(sys.secure).toBe(false);
  });

  test('constructor with options object', () => {
    const sys = new AS400({
      host: 'myhost',
      user: 'USER',
      password: 'PASS',
      secure: true,
      timeout: 5000,
    });
    expect(sys.host).toBe('myhost');
    expect(sys.user).toBe('USER');
    expect(sys.password).toBe('PASS');
    expect(sys.secure).toBe(true);
  });

  test('setters work', () => {
    const sys = new AS400();
    sys.host = 'newhost';
    sys.user = 'NEWUSER';
    sys.password = 'NEWPASS';
    sys.secure = true;
    expect(sys.host).toBe('newhost');
    expect(sys.user).toBe('NEWUSER');
    expect(sys.password).toBe('NEWPASS');
    expect(sys.secure).toBe(true);
  });

  test('getServerName static method', () => {
    expect(AS400.getServerName(Service.FILE)).toBe('as-file');
    expect(AS400.getServerName(Service.SIGNON)).toBe('as-signon');
    expect(AS400.getServerName(Service.COMMAND)).toBe('as-rmtcmd');
    expect(AS400.getServerName(Service.DATABASE)).toBe('as-database');
    expect(AS400.getServerName(Service.DATAQUEUE)).toBe('as-dtaq');
    expect(AS400.getServerName(Service.PRINT)).toBe('as-netprt');
    expect(AS400.getServerName(Service.CENTRAL)).toBe('as-central');
    expect(AS400.getServerName(Service.RECORDACCESS)).toBe('as-ddm');
    expect(AS400.getServerName(Service.HOSTCNN)).toBe('as-hostcnn');
    expect(AS400.getServerName(99)).toBe('unknown');
  });

  test('isServiceConnected returns false initially', () => {
    const sys = new AS400('host', 'user', 'pass');
    expect(sys.isServiceConnected(Service.SIGNON)).toBe(false);
    expect(sys.isServiceConnected(Service.COMMAND)).toBe(false);
  });

  test('getConnection returns null when not connected', () => {
    const sys = new AS400('host');
    expect(sys.getConnection(Service.SIGNON)).toBeNull();
  });

  test('disconnectService is safe when not connected', () => {
    const sys = new AS400('host');
    sys.disconnectService(Service.SIGNON); // should not throw
  });

  test('close is safe when no connections', async () => {
    const sys = new AS400('host');
    await sys.close();
    expect(sys.signedOn).toBe(false);
  });

  test('server attributes cache', () => {
    const sys = new AS400('host');
    expect(sys.getServerAttributes(Service.SIGNON)).toBeNull();

    sys.setServerAttributes(Service.SIGNON, { passwordLevel: 3 });
    expect(sys.getServerAttributes(Service.SIGNON)).toEqual({ passwordLevel: 3 });
  });

  test('library list and current library', () => {
    const sys = new AS400('host');
    expect(sys.currentLibrary).toBe('');
    expect(sys.libraryList).toEqual([]);

    sys.currentLibrary = 'MYLIB';
    sys.libraryList = ['QGPL', 'QTEMP'];
    expect(sys.currentLibrary).toBe('MYLIB');
    expect(sys.libraryList).toEqual(['QGPL', 'QTEMP']);
  });

  test('iasp and namingMode', () => {
    const sys = new AS400('host');
    expect(sys.iasp).toBe('');
    expect(sys.namingMode).toBe('system');

    sys.iasp = 'MYIASP';
    sys.namingMode = 'sql';
    expect(sys.iasp).toBe('MYIASP');
    expect(sys.namingMode).toBe('sql');
  });

  test('connectService fails for unreachable host', async () => {
    const sys = new AS400({
      host: '192.0.2.1',
      user: 'user',
      password: 'pass',
      ports: { [Service.SIGNON]: 8476 },
      timeout: 500,
    });
    try {
      await sys.connectService(Service.SIGNON);
      expect(true).toBe(false);
    } catch (err) {
      expect(err.name).toBe('ConnectionDroppedError');
    }
  });
});
