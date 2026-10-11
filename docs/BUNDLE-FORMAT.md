# The `accounts.tdmk` format

Written so that a bundle can be opened without this extension — if Tidemark disappears, a
short script and your passphrase are enough to get your accounts back.

## Layout

Three lines, UTF-8:

```
TDMK1
{"v":1,"kdf":"scrypt","N":65536,"r":8,"p":1,"keyLen":32,"salt":"<base64>","alg":"aes-256-gcm","iv":"<base64>"}
<base64 of ciphertext || 16-byte GCM tag>
```

1. **Magic** — `TDMK1`. Anything else is not a bundle.
2. **Header** — JSON, and also the AEAD associated data. Editing the cost parameters or the
   salt therefore fails as a bad passphrase rather than quietly weakening the file.
3. **Body** — base64. The last 16 bytes are the GCM authentication tag; everything before them
   is the ciphertext.

## Key derivation

```
key = scrypt(passphrase.normalize("NFKC"), base64decode(salt), keyLen, { N, r, p })
```

Defaults are `N = 2^16`, `r = 8`, `p = 1`, `keyLen = 32` — roughly 64 MB and a third of a
second. The parameters are read from the header, not assumed, so older bundles keep opening if
the defaults change.

## Plaintext

```json
{
  "version": 1,
  "updatedAt": "2026-10-10T09:00:00.000Z",
  "updatedBy": "xp17",
  "profiles": [
    {
      "id": "uuid",
      "label": "you@example.com",
      "addedAt": "2026-10-01T00:00:00.000Z",
      "lastUsedAt": "2026-10-10T08:00:00.000Z",
      "identity": { "email": "you@example.com", "plan": "Max 20x", "accountUuid": "…" },
      "credentials": {
        "claudeAiOauth": {
          "accessToken": "…",
          "refreshToken": "…",
          "expiresAt": 1760000000000,
          "scopes": ["user:inference", "user:profile"]
        }
      }
    }
  ]
}
```

`credentials.claudeAiOauth` is exactly the shape Claude Code keeps in
`~/.claude/.credentials.json`, so restoring an account by hand is a copy.

## Opening one without the extension

```js
// node open-bundle.mjs accounts.tdmk
import { readFileSync } from 'node:fs';
import { createDecipheriv, scryptSync } from 'node:crypto';

const [magic, header, ...rest] = readFileSync(process.argv[2], 'utf8').split('\n');
if (magic.trim() !== 'TDMK1') throw new Error('not a bundle');
const h = JSON.parse(header);
const body = Buffer.from(rest.join('').trim(), 'base64');
const key = scryptSync(process.env.PASSPHRASE.normalize('NFKC'), Buffer.from(h.salt, 'base64'), h.keyLen, {
  N: h.N, r: h.r, p: h.p, maxmem: 256 * h.N * h.r,
});
const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(h.iv, 'base64'));
decipher.setAAD(Buffer.from(header, 'utf8'));
decipher.setAuthTag(body.subarray(body.length - 16));
process.stdout.write(
  Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8'),
);
```

## Merging

Two machines can write between pulls. Merging happens on the decrypted payload, never by git:
accounts are unioned by `id`, and where both sides hold the same account the copy whose
`expiresAt` is later wins, because that is the one whose token has not been rotated away.
Equal tokens break towards the copy not flagged `needsSignIn`, then the later `lastUsedAt`.
Identity, `addedAt` and `lastUsedAt` are pooled so metadata is never lost.
