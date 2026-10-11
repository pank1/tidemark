import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BundleError, MAGIC, decryptBundle, encryptBundle, passphraseStrength } from '../src/core/crypto';

const SECRET = 'correct horse battery staple';
const PLAINTEXT = JSON.stringify({ profiles: [{ id: 'a', token: 'sk-ant-oat01-example' }] });

test('a bundle survives a round trip', async () => {
  const armoured = await encryptBundle(PLAINTEXT, SECRET);
  assert.ok(armoured.startsWith(`${MAGIC}\n`));
  assert.equal(armoured.includes('sk-ant'), false, 'the plaintext must not be recognisable');
  assert.equal(await decryptBundle(armoured, SECRET), PLAINTEXT);
});

test('two encryptions of the same input differ', async () => {
  const first = await encryptBundle(PLAINTEXT, SECRET);
  const second = await encryptBundle(PLAINTEXT, SECRET);
  assert.notEqual(first, second, 'salt and nonce must be fresh each time');
});

test('the wrong passphrase is reported as such', async () => {
  const armoured = await encryptBundle(PLAINTEXT, SECRET);
  await assert.rejects(
    () => decryptBundle(armoured, 'not the passphrase'),
    (error: unknown) => error instanceof BundleError && error.kind === 'passphrase',
  );
});

test('altered ciphertext is rejected', async () => {
  const armoured = await encryptBundle(PLAINTEXT, SECRET);
  const lines = armoured.split('\n');
  const body = Buffer.from(lines[2]!, 'base64');
  body[0] = body[0]! ^ 0xff;
  lines[2] = body.toString('base64');
  await assert.rejects(
    () => decryptBundle(lines.join('\n'), SECRET),
    (error: unknown) => error instanceof BundleError && error.kind === 'passphrase',
  );
});

test('altered cost parameters are rejected because the header is authenticated', async () => {
  const armoured = await encryptBundle(PLAINTEXT, SECRET);
  const lines = armoured.split('\n');
  const header = JSON.parse(lines[1]!) as { N: number };
  lines[1] = JSON.stringify({ ...header, N: 1024 });
  await assert.rejects(
    () => decryptBundle(lines.join('\n'), SECRET),
    (error: unknown) => error instanceof BundleError && error.kind === 'passphrase',
  );
});

test('something that is not a bundle says so', async () => {
  await assert.rejects(
    () => decryptBundle('hello\n{}\nnope\n', SECRET),
    (error: unknown) => error instanceof BundleError && error.kind === 'format',
  );
});

test('a future version is refused rather than guessed at', async () => {
  const armoured = await encryptBundle(PLAINTEXT, SECRET);
  const lines = armoured.split('\n');
  lines[1] = JSON.stringify({ ...(JSON.parse(lines[1]!) as object), v: 2 });
  await assert.rejects(
    () => decryptBundle(lines.join('\n'), SECRET),
    (error: unknown) => error instanceof BundleError && error.kind === 'version',
  );
});

test('an empty passphrase is never accepted', async () => {
  await assert.rejects(() => encryptBundle(PLAINTEXT, ''), BundleError);
});

test('passphrase strength is advice, not a gate, above the minimum', () => {
  assert.equal(passphraseStrength('').ok, false);
  assert.equal(passphraseStrength('short').ok, false);
  assert.equal(passphraseStrength('twelvechars1').ok, true);
  assert.equal(passphraseStrength('correct horse battery staple').ok, true);
});
