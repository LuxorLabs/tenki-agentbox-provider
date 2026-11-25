/**
 * The tiny interactive surface the credential setup needs — a banner, a
 * yes/no, and a masked secret — on top of `node:readline`, so the package
 * ships no prompt library.
 *
 * Call shapes are the ones `credentials.ts` already used (`confirm({…})`,
 * `password({…})`, `isCancel(…)`), so that file only swaps its import. Output
 * is plain text: no colour and no spinner. The only terminal control is in the
 * masked prompt, which writes one `*` per character and `\b \b` to erase one.
 *
 * Ctrl+C resolves with the `CANCEL` symbol instead of throwing; `exitOnCancel`
 * in credentials.ts turns that into exit 130. Return types say `| symbol` (as
 * `@clack/prompts` did) so that guard's `T | symbol` parameter still infers the
 * payload type at the call site — `| Cancel` would poison `T`.
 */

import { createInterface } from 'node:readline/promises';

export const CANCEL = Symbol('cancel');

export type Cancel = typeof CANCEL;

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function intro(title: string): void {
  line();
  line(`┌  ${title}`);
}

export function note(body: string, title: string): void {
  line('│');
  line(`│  ${title}`);
  for (const l of body.split('\n')) line(`│  ${l}`);
  line('│');
}

export function outro(message: string): void {
  line(`└  ${message}`);
  line();
}

export function cancel(message: string): void {
  line(`■  ${message}`);
  line();
}

export const log = {
  success(message: string): void {
    line(`│  ✔ ${message}`);
  },
  warn(message: string): void {
    line(`│  ⚠ ${message}`);
  },
};

export function isCancel(value: unknown): value is Cancel {
  return value === CANCEL;
}

/**
 * One line. EOF, or the interface closing under us, means `CANCEL`. With
 * `echo: false` the interface gets no output and runs in non-terminal mode, so
 * readline never writes what it reads back to stdout: the masked prompt's pipe
 * fallback uses that, since stdout may still be a terminal when stdin is a pipe.
 */
async function question(query: string, { echo = true } = {}): Promise<string | Cancel> {
  const rl = echo
    ? createInterface({ input: process.stdin, output: process.stdout })
    : createInterface({ input: process.stdin, terminal: false });
  try {
    return (await rl.question(query)).trim();
  } catch {
    return CANCEL;
  } finally {
    rl.close();
  }
}

/**
 * Where the masked reader is inside an escape sequence. Arrow keys, Home/End,
 * Delete and the bracketed-paste markers arrive as `ESC [ … final` (CSI) or
 * `ESC O x` (SS3); a terminal may split one across reads, so this survives
 * between chunks.
 */
type EscapeState = 'none' | 'esc' | 'csi' | 'ss3';

export interface SecretInput {
  value: string;
  escape: EscapeState;
}

export function newSecretInput(): SecretInput {
  return { value: '', escape: 'none' };
}

/**
 * Feed one raw-mode chunk to the masked reader. Returns what to write back to
 * the terminal (only `*` and `\b \b`, never the typed characters) and, once
 * the line ends, whether it was submitted or cancelled. Enter submits; Ctrl+C
 * and Ctrl+D cancel, as `@clack/prompts` did. Escape sequences are consumed
 * whole and ignored, so they can't put stray bytes into the token; the text
 * between bracketed-paste markers is kept, since that is the pasted token. An
 * ESC followed by anything else (Alt+key) drops both characters.
 */
export function feedSecretInput(
  input: SecretInput,
  chunk: string,
): { echo: string; done?: 'submit' | 'cancel' } {
  let echo = '';
  const eraseOne = (): void => {
    if (input.value.length === 0) return;
    input.value = input.value.slice(0, -1);
    echo += '\b \b';
  };
  for (const ch of chunk) {
    // A control character never belongs to a sequence: it ends a malformed or
    // abandoned one (a lone Esc, then Enter) and is handled as itself below.
    if (input.escape !== 'none' && ch < ' ') input.escape = 'none';
    if (input.escape === 'esc') {
      input.escape = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'none';
      continue;
    }
    if (input.escape === 'csi') {
      // Parameter and intermediate bytes are 0x20-0x3F; the final byte (0x40-0x7E) ends it.
      if (ch >= '@' && ch <= '~') input.escape = 'none';
      continue;
    }
    if (input.escape === 'ss3') {
      input.escape = 'none';
      continue;
    }
    if (ch === '\u001b') {
      input.escape = 'esc';
      continue;
    }
    if (ch === '\r' || ch === '\n') return { echo, done: 'submit' };
    if (ch === '\u0003' || ch === '\u0004') return { echo, done: 'cancel' };
    if (ch === '\u007f' || ch === '\b') {
      eraseOne();
      continue;
    }
    if (ch === '\u0015') {
      // Ctrl+U — clear the line, for a bad paste.
      while (input.value.length > 0) eraseOne();
      continue;
    }
    if (ch < ' ') continue;
    input.value += ch;
    echo += '*';
  }
  return { echo };
}

/**
 * One line with the characters masked. On a TTY this reads raw mode itself and
 * echoes `*` per character (plain `readline` leaves the terminal's own echo on,
 * which would print the token); on a pipe it falls back to `question` with
 * echo off, so nothing is written back even when stdout is a terminal. stdin ending
 * under us (the terminal went away) cancels rather than hanging.
 */
function questionSecret(query: string): Promise<string | Cancel> {
  const { stdin, stdout } = process;
  stdout.write(query);
  if (!stdin.isTTY) return question('', { echo: false });

  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const input = newSecretInput();
    const finish = (result: string | Cancel): void => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      if (!stdin.destroyed) stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(result);
    };
    const onEnd = (): void => finish(CANCEL);
    const onData = (chunk: string): void => {
      const { echo, done } = feedSecretInput(input, chunk);
      if (echo) stdout.write(echo);
      if (done) finish(done === 'submit' ? input.value : CANCEL);
    };
    stdin.on('data', onData);
    stdin.once('end', onEnd);
  });
}

export async function confirm(opts: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean | symbol> {
  const initial = opts.initialValue ?? true;
  const answer = await question(`${opts.message} ${initial ? '(Y/n)' : '(y/N)'} `);
  if (answer === CANCEL) return CANCEL;
  const a = answer.toLowerCase();
  if (a === '') return initial;
  return a === 'y' || a === 'yes';
}

export async function password(opts: {
  message: string;
  validate?: (value: string | undefined) => string | undefined;
}): Promise<string | symbol> {
  line(opts.message);
  for (;;) {
    const answer = await questionSecret('> ');
    if (answer === CANCEL) return CANCEL;
    const problem = opts.validate?.(answer);
    if (problem === undefined) return answer;
    log.warn(problem);
  }
}
