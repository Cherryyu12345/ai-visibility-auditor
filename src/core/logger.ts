/**
 * Logging with credential redaction as a hard rule.
 *
 * Two layers, because either alone fails:
 *   1. Key-name redaction catches secrets in objects we structure ourselves.
 *   2. Value registration catches secrets pasted into URLs, headers or error
 *      strings by code that never knew they were secret.
 */

const SENSITIVE_KEYS = [
  'password', 'app_password', 'applicationpassword', 'secret', 'token',
  'apikey', 'api_key', 'authorization', 'auth', 'credential', 'cookie',
  'clientsecret', 'client_secret', 'refresh_token', 'access_token', 'dek',
  'wrappedkey', 'masterkey', 'aiva_master_key',
];

const REDACTED = '[redacted]';

/** Secret values registered at runtime, scrubbed from every logged string. */
const liveSecrets = new Set<string>();

/**
 * Register a secret so it is scrubbed wherever it appears. Call this the moment
 * a credential is decrypted. Short values are ignored: scrubbing a 3-character
 * secret would redact unrelated text everywhere.
 */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) liveSecrets.add(value);
}

export function forgetSecret(value: string): void {
  liveSecrets.delete(value);
}

/** Test seam only. */
export function _clearSecrets(): void {
  liveSecrets.clear();
}

function scrubString(s: string): string {
  let out = s;
  for (const secret of liveSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  // Basic-auth credentials embedded in URLs, e.g. https://user:pass@host/
  out = out.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//' + REDACTED + '@');
  return out;
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_\s]/g, '');
  return SENSITIVE_KEYS.some((s) => k.includes(s.replace(/[-_]/g, '')));
}

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, seen);
  }
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  (level: LogLevel, message: string, context?: Record<string, unknown>): void;
}

let sink: LogSink = (level, message, context) => {
  const line = { level, message, ...(context ?? {}) };
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](JSON.stringify(line));
};

export function setLogSink(custom: LogSink): void {
  sink = custom;
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  sink(level, scrubString(message), context ? (redact(context) as Record<string, unknown>) : undefined);
}

export const log = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
};
