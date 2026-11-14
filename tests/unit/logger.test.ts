import { describe, it, expect, beforeEach } from 'vitest';
import { redact, registerSecret, _clearSecrets, setLogSink, log } from '../../src/core/logger.js';

describe('credential redaction', () => {
  beforeEach(() => _clearSecrets());

  it('redacts by key name', () => {
    const out = redact({ username: 'admin', applicationPassword: 'abcd efgh', nested: { api_key: 'k' } });
    expect(out).toEqual({ username: 'admin', applicationPassword: '[redacted]', nested: { api_key: '[redacted]' } });
  });

  it('redacts a registered secret wherever it appears, including inside URLs', () => {
    registerSecret('abcd1234efgh');
    const out = redact({ url: 'https://site.test/x?token=abcd1234efgh', note: 'uses abcd1234efgh' });
    expect(JSON.stringify(out)).not.toContain('abcd1234efgh');
  });

  it('strips basic-auth credentials embedded in a URL', () => {
    const out = redact('https://admin:hunter2pass@site.test/wp-json/');
    expect(out).toBe('https://[redacted]@site.test/wp-json/');
  });

  it('ignores very short secrets, which would redact unrelated text', () => {
    registerSecret('abc');
    expect(redact('abc def')).toBe('abc def');
  });

  it('redacts secrets inside Error messages', () => {
    registerSecret('topsecretvalue');
    const out = redact(new Error('failed with topsecretvalue')) as { message: string };
    expect(out.message).toBe('failed with [redacted]');
  });

  it('survives circular structures', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });

  it('scrubs the log message itself, not just the context', () => {
    registerSecret('leakyvalue123');
    const lines: string[] = [];
    setLogSink((_l, m) => lines.push(m));
    log.info('request failed for leakyvalue123');
    expect(lines[0]).toBe('request failed for [redacted]');
  });
});
