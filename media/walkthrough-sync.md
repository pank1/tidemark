## The same accounts on every machine

Sync puts your accounts into **one encrypted file** in **your own private git
repository**:

```
your-private-repo/
  accounts.tdmk      ← scrypt + AES-256-GCM, opened by your passphrase
  presence/          ← "xp17 is on account 3", no email addresses
  README.md
```

On a second machine: install Tidemark, point it at the same repository,
enter the same passphrase. Every account is there, with no signing in again.

**The passphrase is the only thing protecting that file, and there is no
recovery if it is lost.** By default it is asked for once per window and held in
memory only; you can opt into keeping it in your operating system's keychain,
which is what lets auto-failover work while you are away from the machine.
