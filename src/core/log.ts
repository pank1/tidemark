export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  debug(message: string, ...rest: unknown[]): void;
}

export const nullLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // OAuth access/refresh tokens as issued by the Claude clients.
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g, replacement: '<redacted>' },
  { pattern: /\b(?:oat|ort)[A-Za-z0-9_-]{12,}\b/g, replacement: '<redacted>' },
  // Anything that calls itself a token/secret/passphrase in a serialised blob.
  { pattern: /("(?:access|refresh)?[Tt]oken"\s*:\s*")[^"]+(")/g, replacement: '$1<redacted>$2' },
  { pattern: /("(?:passphrase|password|secret|authToken)"\s*:\s*")[^"]+(")/g, replacement: '$1<redacted>$2' },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, replacement: '$1<redacted>' },
  // Git remotes carry a token in the userinfo part: https://user:ghp_xxx@host/…
  { pattern: /(:\/\/)[^/\s:@]+:[^/\s@]+(@)/g, replacement: '$1<redacted>$2' },
];

/**
 * Last line of defence before anything reaches a log, an error message or the
 * clipboard. Redaction happens here rather than at each call site so a new call
 * site cannot forget (review item R1).
 */
export function redact(input: unknown): string {
  let text = typeof input === 'string' ? input : safeStringify(input);
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/** Emails are not secrets, but they are the user's identity; blur for logs. */
export function blurEmail(email: string | undefined): string {
  if (!email) return 'unknown';
  const at = email.indexOf('@');
  if (at < 1) return 'unknown';
  const name = email.slice(0, at);
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${'*'.repeat(Math.max(0, name.length - head.length))}${email.slice(at)}`;
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
