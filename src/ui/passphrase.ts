import * as vscode from 'vscode';

import { Logger } from '../core/log';
import { passphraseStrength } from '../core/crypto';

const SECRET_KEY = 'tidemark.sync.passphrase';

/**
 * Holds the sync passphrase for as long as this window lives.
 *
 * Nothing is written to disk by default (the round-3 choice): the passphrase is
 * asked for when it is needed and kept in memory. `rememberPassphrase` opts in
 * to VS Code's SecretStorage — the OS keychain — which is what makes unattended
 * auto-failover possible.
 */
export class PassphraseHolder {
  private cached?: string;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: Logger,
  ) {}

  get locked(): boolean {
    return this.cached === undefined;
  }

  async lock(): Promise<void> {
    this.cached = undefined;
    await this.secrets.delete(SECRET_KEY).then(undefined, () => undefined);
    this.emitter.fire();
  }

  /** Loads a remembered passphrase, if the user asked us to remember one. */
  async restore(): Promise<void> {
    if (!remember()) return;
    try {
      const stored = await this.secrets.get(SECRET_KEY);
      if (stored) {
        this.cached = stored;
        this.emitter.fire();
      }
    } catch (error) {
      this.log.debug(`could not read the remembered passphrase: ${String(error)}`);
    }
  }

  /**
   * Returns the passphrase, prompting when necessary. `prompt: false` is how
   * background work (polling, failover) asks without stealing focus.
   */
  async get(purpose: string, options: { prompt?: boolean } = {}): Promise<string | undefined> {
    if (this.cached !== undefined) return this.cached;
    if (options.prompt === false) return undefined;

    const entered = await vscode.window.showInputBox({
      title: 'Tidemark passphrase',
      prompt: `Needed to ${purpose}.`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'Your sync passphrase',
    });
    if (!entered) return undefined;
    await this.hold(entered);
    return entered;
  }

  /** Setup flow: ask twice, refuse something hopeless, confirm the two match. */
  async createNew(): Promise<string | undefined> {
    const first = await vscode.window.showInputBox({
      title: 'Choose a sync passphrase',
      prompt: 'This is the only thing protecting your accounts in the repository. There is no recovery if you lose it.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        const strength = passphraseStrength(value);
        return strength.ok ? undefined : strength.message;
      },
    });
    if (!first) return undefined;

    const second = await vscode.window.showInputBox({
      title: 'Confirm your sync passphrase',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value === first ? undefined : 'The two do not match.'),
    });
    if (second !== first) return undefined;

    await this.hold(first);
    return first;
  }

  /**
   * Writes the passphrase already in memory to the keychain, for when the
   * "remember this" setting is turned on after it was typed.
   */
  async persist(): Promise<boolean> {
    if (this.cached === undefined || !remember()) return false;
    try {
      await this.secrets.store(SECRET_KEY, this.cached);
      return true;
    } catch (error) {
      this.log.warn(`could not remember the passphrase: ${String(error)}`);
      return false;
    }
  }

  /** Called after a wrong-passphrase failure so the user is asked again. */
  async forget(): Promise<void> {
    this.cached = undefined;
    if (remember()) await this.secrets.delete(SECRET_KEY).then(undefined, () => undefined);
    this.emitter.fire();
  }

  private async hold(passphrase: string): Promise<void> {
    this.cached = passphrase;
    if (remember()) {
      try {
        await this.secrets.store(SECRET_KEY, passphrase);
      } catch (error) {
        this.log.warn(`could not remember the passphrase: ${String(error)}`);
      }
    }
    this.emitter.fire();
  }
}

function remember(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>('tidemark.sync.rememberPassphrase', false);
}
