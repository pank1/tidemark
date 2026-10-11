import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blurEmail, redact } from '../src/core/log';

test('tokens never survive a trip through the log', () => {
  const line = redact('writing {"accessToken":"sk-ant-oat01-abcdefghijklmno","expiresAt":1}');
  assert.equal(line.includes('abcdefghijklmno'), false);
  assert.match(line, /"accessToken":"<redacted>"/);
  assert.match(line, /"expiresAt":1/, 'the rest of the line is still readable');
});

test('a bearer header is redacted', () => {
  assert.equal(redact('Authorization: Bearer sk-ant-oat01-secretvalue'), 'Authorization: Bearer <redacted>');
});

test('a git remote carrying a token is redacted', () => {
  const line = redact('fatal: could not read https://someone:ghp_abcdefghijklmnop@github.com/me/accounts.git');
  assert.equal(line.includes('ghp_abcdefghijklmnop'), false);
  assert.match(line, /https:\/\/<redacted>@github\.com/);
});

test('a plain remote is left legible', () => {
  const line = redact('fatal: could not read git@github.com:me/accounts.git');
  assert.match(line, /git@github\.com:me\/accounts\.git/);
});

test('passphrases are redacted wherever they are named', () => {
  assert.match(redact('{"passphrase":"correct horse"}'), /"passphrase":"<redacted>"/);
  assert.match(redact('{"authToken":"abc123"}'), /"authToken":"<redacted>"/);
});

test('errors and objects can be passed straight in', () => {
  assert.equal(redact(new Error('boom')), 'Error: boom');
  assert.equal(redact({ a: 1 }), '{"a":1}');
  assert.equal(redact(undefined), 'undefined');
});

test('emails are blurred, not removed, so accounts stay tellable apart', () => {
  assert.equal(blurEmail('mallory@example.com'), 'ma*****@example.com');
  assert.equal(blurEmail('a@example.com'), 'a@example.com');
  assert.equal(blurEmail(undefined), 'unknown');
  assert.equal(blurEmail('not-an-email'), 'unknown');
});
