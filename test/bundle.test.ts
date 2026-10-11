import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeProfiles, parseBundle, serializeBundle } from '../src/core/bundle';
import { Profile } from '../src/core/types';

function profile(id: string, options: { expiresAt: number; label?: string; needsSignIn?: boolean; lastUsedAt?: string }): Profile {
  return {
    id,
    label: options.label ?? id,
    addedAt: '2026-10-01T00:00:00Z',
    lastUsedAt: options.lastUsedAt,
    needsSignIn: options.needsSignIn,
    credentials: {
      claudeAiOauth: {
        accessToken: `access-${id}-${options.expiresAt}`,
        refreshToken: `refresh-${id}-${options.expiresAt}`,
        expiresAt: options.expiresAt,
      },
    },
  };
}

test('accounts from both sides are kept', () => {
  const merged = mergeProfiles([profile('a', { expiresAt: 10 })], [profile('b', { expiresAt: 10 })]);
  assert.deepEqual(
    merged.profiles.map((entry) => entry.id),
    ['a', 'b'],
  );
  assert.deepEqual(merged.added, ['b']);
});

test('the copy that expires later wins, because it is the one that still works', () => {
  const merged = mergeProfiles(
    [profile('a', { expiresAt: 1000, label: 'local' })],
    [profile('a', { expiresAt: 5000, label: 'remote' })],
  );
  assert.equal(merged.profiles[0]!.credentials.claudeAiOauth.expiresAt, 5000);
  assert.deepEqual(merged.updated, ['remote']);
  assert.deepEqual(merged.kept, []);
});

test('a newer local copy is kept and flagged for pushing back', () => {
  const merged = mergeProfiles(
    [profile('a', { expiresAt: 9000, label: 'local' })],
    [profile('a', { expiresAt: 1000, label: 'remote' })],
  );
  assert.equal(merged.profiles[0]!.credentials.claudeAiOauth.expiresAt, 9000);
  assert.deepEqual(merged.kept, ['local']);
});

test('with equal tokens, the one that is not broken wins', () => {
  const merged = mergeProfiles(
    [profile('a', { expiresAt: 1000, label: 'local', needsSignIn: true })],
    [profile('a', { expiresAt: 1000, label: 'remote' })],
  );
  assert.equal(merged.profiles[0]!.label, 'remote');
});

test('metadata is pooled rather than lost', () => {
  const local: Profile = { ...profile('a', { expiresAt: 5000, lastUsedAt: '2026-10-09T00:00:00Z' }) };
  const remote: Profile = {
    ...profile('a', { expiresAt: 1000, lastUsedAt: '2026-10-10T00:00:00Z' }),
    identity: { email: 'one@example.com', plan: 'Max 20x' },
    addedAt: '2026-09-01T00:00:00Z',
  };
  const merged = mergeProfiles([local], [remote]);
  const result = merged.profiles[0]!;
  assert.equal(result.credentials.claudeAiOauth.expiresAt, 5000, 'the live token is kept');
  assert.equal(result.identity?.email, 'one@example.com', 'identity comes from whichever side has it');
  assert.equal(result.lastUsedAt, '2026-10-10T00:00:00Z', 'the later use is kept');
  assert.equal(result.addedAt, '2026-09-01T00:00:00Z', 'the earlier addition is kept');
});

test('a bundle round-trips and is validated on the way in', () => {
  const payload = {
    version: 1,
    updatedAt: '2026-10-10T09:00:00Z',
    updatedBy: 'xp17',
    profiles: [profile('a', { expiresAt: 10 })],
  };
  const parsed = parseBundle(serializeBundle(payload));
  assert.equal(parsed.profiles.length, 1);
  assert.equal(parsed.updatedBy, 'xp17');

  assert.throws(() => parseBundle('{"version":1,"profiles":[{"id":"a","label":"a"}]}'), /credentials/i);
  assert.throws(() => parseBundle('{"version":99,"profiles":[]}'), /newer/);
  assert.throws(() => parseBundle('{"version":1}'), /profiles/);
});
