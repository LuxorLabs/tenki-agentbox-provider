/**
 * The tiny interactive surface the credential setup needs — a banner, a
 * yes/no, and a masked secret — on top of `node:readline`, so the package
 * ships no prompt library.
 *
 * Call shapes are the ones `credentials.ts` already used (`confirm({…})`,
 * `password({…})`, `isCancel(…)`), so that file only swaps its import. Output
 * is plain text: no colour, no spinner, no `process.stdout` feature beyond one
 * write per line.
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

/** One echoed line. EOF, or the interface closing under us, means `CANCEL`. */
async function question(query: string): Promise<string | Cancel> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } catch {
    return CANCEL;
  } finally {
    rl.close();
  }
}

/**
 * One line with the characters masked. On a TTY this reads raw mode itself and
 * echoes `*` per character (plain `readline` leaves the terminal's own echo on,
 * which would print the token); on a pipe it falls back to `question`, where
 * nothing echoes because the producer of the pipe owns the echo.
 */
function questionSecret(query: string): Promise<string | Cancel> {
  const { stdin, stdout } = process;
  stdout.write(query);
  if (!stdin.isTTY) return question('');

  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const finish = (result: string | Cancel): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(result);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(value);
        if (ch === '\u0003') return finish(CANCEL);
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (ch === '\u0015') {
          // Ctrl+U — clear the line, for a bad paste.
          while (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
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
