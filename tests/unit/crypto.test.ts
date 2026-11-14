import { describe, it, expect, beforeEach } from 'vitest';
import { seal, open, generateMasterKey, safeEqual, MissingMasterKey } from '../../src/core/crypto.js';

describe('credential sealing', () => {
  beforeEach(() => { process.env.AIVA_MASTER_KEY = generateMasterKey(); });

  it('round-trips a credential', () => {
    const secret = { username: 'admin', applicationPassword: 'abcd efgh ijkl mnop' };
    expect(open(seal(secret))).toEqual(secret);
  });

  it('never stores plaintext in the sealed blob', () => {
    const sealed = seal({ applicationPassword: 'super-secret-value' });
    expect(JSON.stringify(sealed)).not.toContain('super-secret-value');
  });

  it('uses a fresh data key each time, so identical inputs differ', () => {
    const a = seal({ k: 'v' });
    const b = seal({ k: 'v' });
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.wrappedKey).not.toEqual(b.wrappedKey);
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const sealed = seal({ k: 'value' });
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(() => open({ ...sealed, ciphertext: bytes.toString('base64') })).toThrow();
  });

  it('refuses a tampered wrapped key', () => {
    const sealed = seal({ k: 'value' });
    const bytes = Buffer.from(sealed.wrappedKey, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(() => open({ ...sealed, wrappedKey: bytes.toString('base64') })).toThrow();
  });

  it('cannot be opened with a different master key', () => {
    const sealed = seal({ k: 'value' });
    process.env.AIVA_MASTER_KEY = generateMasterKey();
    expect(() => open(sealed)).toThrow();
  });

  it('explains how to fix a missing master key', () => {
    delete process.env.AIVA_MASTER_KEY;
    expect(() => seal({ k: 'v' })).toThrow(MissingMasterKey);
  });

  it('rejects a master key of the wrong length', () => {
    process.env.AIVA_MASTER_KEY = Buffer.from('too-short').toString('base64');
    expect(() => seal({ k: 'v' })).toThrow(/32 bytes/);
  });

  it('compares tokens without leaking length via early exit', () => {
    expect(safeEqual('token-abc', 'token-abc')).toBe(true);
    expect(safeEqual('token-abc', 'token-abd')).toBe(false);
    expect(safeEqual('short', 'much-longer')).toBe(false);
  });
});
