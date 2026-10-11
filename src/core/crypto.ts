import * as crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

export const MAGIC = 'TDMK1';

/**
 * scrypt cost. 2^16 · r=8 needs ~64 MB and about a third of a second on a
 * laptop — slow enough to make a stolen bundle expensive to attack, fast enough
 * that unlocking does not feel broken. The parameters travel in the header so a
 * bundle written today still opens if these change.
 */
const KDF = { N: 1 << 16, r: 8, p: 1, keyLen: 32 } as const;

export type BundleErrorKind = 'format' | 'passphrase' | 'version';

export class BundleError extends Error {
  constructor(
    readonly kind: BundleErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

interface Header {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  keyLen: number;
  salt: string;
  alg: 'aes-256-gcm';
  iv: string;
}

/**
 * Armoured output, three lines:
 *   TDMK1
 *   {"v":1,"kdf":"scrypt",…}
 *   <base64 ciphertext><base64 tag, last 24 chars>
 * The header is authenticated as AAD, so editing the cost parameters or the
 * salt fails as a bad passphrase rather than silently weakening anything.
 */
export async function encryptBundle(plaintext: string, passphrase: string): Promise<string> {
  assertPassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header: Header = {
    v: 1,
    kdf: 'scrypt',
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    keyLen: KDF.keyLen,
    salt: salt.toString('base64'),
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
  };
  const headerJson = JSON.stringify(header);
  const key = await deriveKey(passphrase, salt, header);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(headerJson, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  return `${MAGIC}\n${headerJson}\n${Buffer.concat([ciphertext, tag]).toString('base64')}\n`;
}

export async function decryptBundle(armoured: string, passphrase: string): Promise<string> {
  assertPassphrase(passphrase);
  const lines = armoured.split('\n');
  if (lines[0]?.trim() !== MAGIC) {
    throw new BundleError('format', 'This file is not a Tidemark bundle.');
  }
  let header: Header;
  try {
    header = JSON.parse(lines[1] ?? '') as Header;
  } catch {
    throw new BundleError('format', 'Bundle header is corrupt.');
  }
  if (header.v !== 1 || header.kdf !== 'scrypt' || header.alg !== 'aes-256-gcm') {
    throw new BundleError('version', 'This bundle was written by a newer Tidemark.');
  }

  const body = Buffer.from(lines.slice(2).join('').trim(), 'base64');
  if (body.length <= 16) throw new BundleError('format', 'Bundle body is truncated.');
  const ciphertext = body.subarray(0, body.length - 16);
  const tag = body.subarray(body.length - 16);

  const key = await deriveKey(passphrase, Buffer.from(header.salt, 'base64'), header);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAAD(Buffer.from(lines[1] ?? '', 'utf8'));
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new BundleError('passphrase', 'Wrong passphrase, or the bundle has been altered.');
  } finally {
    key.fill(0);
  }
}

async function deriveKey(passphrase: string, salt: Buffer, header: Header): Promise<Buffer> {
  const keyLen = header.keyLen === 32 ? 32 : 32;
  return scrypt(passphrase.normalize('NFKC'), salt, keyLen, {
    N: header.N,
    r: header.r,
    p: header.p,
    // Node refuses the default 32 MB cap for these costs.
    maxmem: Math.max(32 * 1024 * 1024, 256 * header.N * header.r),
  });
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new BundleError('passphrase', 'A passphrase is required.');
  }
}

/** Shown in the sync setup wizard so people do not pick something hopeless. */
export function passphraseStrength(passphrase: string): { ok: boolean; message: string } {
  const length = passphrase.length;
  if (length === 0) return { ok: false, message: 'Enter a passphrase.' };
  if (length < 12) return { ok: false, message: 'Use at least 12 characters — this guards every account.' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(passphrase)).length;
  const words = passphrase.trim().split(/\s+/).length;
  if (length >= 20 || words >= 4 || classes >= 3) return { ok: true, message: 'Strong enough.' };
  return { ok: true, message: 'Acceptable — longer or several words would be better.' };
}
