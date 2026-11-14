/**
 * Envelope encryption for connector credentials.
 *
 * Each credential blob gets its own random data key (DEK). The DEK is wrapped
 * with a master key (KEK) that comes from the environment — and in production
 * should come from a KMS, never from a file next to the code.
 *
 * Rationale for envelope rather than encrypting straight with the master key:
 * rotating the master key only requires rewrapping short DEKs, not rewriting
 * every credential; and a leaked DEK compromises exactly one connection.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface SealedSecret {
  /** Format version, so the wrapping scheme can change without data loss. */
  v: 1;
  /** DEK, encrypted under the master key. base64. */
  wrappedKey: string;
  wrapIv: string;
  wrapTag: string;
  /** Payload, encrypted under the DEK. base64. */
  ciphertext: string;
  iv: string;
  tag: string;
}

export class MissingMasterKey extends Error {
  constructor() {
    super(
      'AIVA_MASTER_KEY is not set. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
    this.name = 'MissingMasterKey';
  }
}

function masterKey(): Buffer {
  const raw = process.env.AIVA_MASTER_KEY;
  if (!raw) throw new MissingMasterKey();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`AIVA_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

function encryptWith(key: Buffer, plaintext: Buffer): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptWith(key: Buffer, ciphertext: string, iv: string, tag: string): Buffer {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
}

/** Encrypt a credential object. The plaintext never touches disk or logs. */
export function seal(secret: Record<string, string>): SealedSecret {
  const dek = randomBytes(KEY_BYTES);
  const body = encryptWith(dek, Buffer.from(JSON.stringify(secret), 'utf8'));
  const wrapped = encryptWith(masterKey(), dek);
  dek.fill(0);
  return {
    v: 1,
    wrappedKey: wrapped.ciphertext,
    wrapIv: wrapped.iv,
    wrapTag: wrapped.tag,
    ciphertext: body.ciphertext,
    iv: body.iv,
    tag: body.tag,
  };
}

export function open(sealed: SealedSecret): Record<string, string> {
  if (sealed.v !== 1) throw new Error(`Unsupported sealed secret version: ${sealed.v}`);
  const dek = decryptWith(masterKey(), sealed.wrappedKey, sealed.wrapIv, sealed.wrapTag);
  try {
    return JSON.parse(decryptWith(dek, sealed.ciphertext, sealed.iv, sealed.tag).toString('utf8'));
  } finally {
    dek.fill(0);
  }
}

/** Constant-time compare, for share-link tokens and similar. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
