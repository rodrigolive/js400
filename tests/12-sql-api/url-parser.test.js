/**
 * Tests for JDBC URL parser — parseJdbcUrl().
 */
import { describe, test, expect } from 'bun:test';
import { parseJdbcUrl } from '../../src/db/url.js';

describe('parseJdbcUrl', () => {
  test('parses basic host-only URL', () => {
    const result = parseJdbcUrl('jdbc:as400://myhost');
    expect(result.protocol).toBe('jdbc:as400');
    expect(result.host).toBe('myhost');
    expect(result.defaultSchema).toBeUndefined();
  });

  test('parses host with default schema', () => {
    const result = parseJdbcUrl('jdbc:as400://myhost/MYLIB');
    expect(result.host).toBe('myhost');
    expect(result.defaultSchema).toBe('MYLIB');
  });

  test('parses host with port', () => {
    const result = parseJdbcUrl('jdbc:as400://myhost:8471/MYLIB');
    expect(result.host).toBe('myhost');
    expect(result.port).toBe(8471);
    expect(result.defaultSchema).toBe('MYLIB');
  });

  test('parses semicolon-separated properties', () => {
    const result = parseJdbcUrl('jdbc:as400://myhost/MYLIB;naming=sql;date format=iso');
    expect(result.host).toBe('myhost');
    expect(result.defaultSchema).toBe('MYLIB');
    expect(result.naming).toBe('sql');
    expect(result.dateFormat).toBe('*ISO');
  });

  test('parses user and password properties', () => {
    const result = parseJdbcUrl('jdbc:as400://myhost;user=MYUSER;password=secret');
    expect(result.host).toBe('myhost');
    expect(result.user).toBe('MYUSER');
    expect(result.password).toBe('secret');
  });

  test('parses libraries property as array', () => {
    const result = parseJdbcUrl('jdbc:as400://myhost;libraries=LIB1,LIB2,LIB3');
    expect(result.libraries).toEqual(['LIB1', 'LIB2', 'LIB3']);
  });

  test('parses boolean properties', () => {
    const result = parseJdbcUrl('jdbc:as400://myhost;secure=true;auto commit=false;prefetch=1');
    expect(result.secure).toBe(true);
    expect(result.autoCommit).toBe(false);
    expect(result.prefetch).toBe(true);
  });

  test('parses naming=system', () => {
    const result = parseJdbcUrl('jdbc:as400://myhost;naming=system');
    expect(result.naming).toBe('system');
  });

  test('normalizes date format values', () => {
    const r1 = parseJdbcUrl('jdbc:as400://h;date format=iso');
    expect(r1.dateFormat).toBe('*ISO');

    const r2 = parseJdbcUrl('jdbc:as400://h;date format=usa');
    expect(r2.dateFormat).toBe('*USA');

    const r3 = parseJdbcUrl('jdbc:as400://h;date format=mdy');
    expect(r3.dateFormat).toBe('*MDY');
  });

  test('normalizes time format values', () => {
    const r1 = parseJdbcUrl('jdbc:as400://h;time format=hms');
    expect(r1.timeFormat).toBe('*HMS');

    const r2 = parseJdbcUrl('jdbc:as400://h;time format=iso');
    expect(r2.timeFormat).toBe('*ISO');
  });

  test('parses block size as number', () => {
    const result = parseJdbcUrl('jdbc:as400://h;block size=64');
    expect(result.blockSize).toBe(64);
  });

  test('handles database name / default collection aliases', () => {
    const r1 = parseJdbcUrl('jdbc:as400://h;database name=MYDB');
    expect(r1.defaultSchema).toBe('MYDB');

    const r2 = parseJdbcUrl('jdbc:as400://h;default collection=MYDB');
    expect(r2.defaultSchema).toBe('MYDB');
  });

  test('keeps unknown properties with original key', () => {
    const result = parseJdbcUrl('jdbc:as400://h;custom prop=value');
    expect(result['custom prop']).toBe('value');
  });

  test('URL path schema takes precedence unless overridden by property', () => {
    const result = parseJdbcUrl('jdbc:as400://h/SCHEMA1;database name=SCHEMA2');
    // The property overwrites the path schema
    expect(result.defaultSchema).toBe('SCHEMA2');
  });

  test('handles empty properties gracefully', () => {
    const result = parseJdbcUrl('jdbc:as400://h;');
    expect(result.host).toBe('h');
  });

  test('handles multiple semicolons', () => {
    const result = parseJdbcUrl('jdbc:as400://h;;naming=sql;;');
    expect(result.naming).toBe('sql');
  });

  test('throws on non-string input', () => {
    expect(() => parseJdbcUrl(123)).toThrow('Expected a JDBC URL string');
  });

  test('throws on non-jdbc URL', () => {
    expect(() => parseJdbcUrl('https://example.com')).toThrow('Expected a jdbc:as400:// URL');
  });

  test('handles full complex URL', () => {
    const result = parseJdbcUrl(
      'jdbc:as400://prod.ibmi.local:8471/PRODLIB;user=PRODUSER;password=s3cr3t;naming=sql;libraries=PRODLIB,QGPL;date format=iso;time format=hms;secure=true;block size=128'
    );
    expect(result.host).toBe('prod.ibmi.local');
    expect(result.port).toBe(8471);
    expect(result.defaultSchema).toBe('PRODLIB');
    expect(result.user).toBe('PRODUSER');
    expect(result.password).toBe('s3cr3t');
    expect(result.naming).toBe('sql');
    expect(result.libraries).toEqual(['PRODLIB', 'QGPL']);
    expect(result.dateFormat).toBe('*ISO');
    expect(result.timeFormat).toBe('*HMS');
    expect(result.secure).toBe(true);
    expect(result.blockSize).toBe(128);
  });
});
