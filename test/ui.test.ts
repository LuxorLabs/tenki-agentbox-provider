import { describe, expect, it } from 'vitest';
import { feedSecretInput, newSecretInput } from '../src/ui.js';

const TOKEN = 'tk_live_SECRET123';

/** Feed chunks in order until the line ends; collect everything echoed. */
function run(...chunks: string[]) {
  const input = newSecretInput();
  let echo = '';
  let done: 'submit' | 'cancel' | undefined;
  for (const chunk of chunks) {
    const step = feedSecretInput(input, chunk);
    echo += step.echo;
    done = step.done;
    if (done) break;
  }
  return { value: input.value, echo, done };
}

describe('feedSecretInput', () => {
  it('submits on Enter and echoes only a mask', () => {
    const r = run(`${TOKEN}\r`);
    expect(r).toMatchObject({ value: TOKEN, done: 'submit' });
    expect(r.echo).toBe('*'.repeat(TOKEN.length));
  });

  it('cancels on Ctrl+C and on Ctrl+D (end of input)', () => {
    expect(run('tk_abc\u0003').done).toBe('cancel');
    expect(run('tk_abc\u0004').done).toBe('cancel');
    expect(run('\u0004').done).toBe('cancel');
  });

  it('ignores arrow, Home/End and Delete escape sequences', () => {
    const keys = [
      '\u001b[D',
      '\u001b[C',
      '\u001b[A',
      '\u001bOH',
      '\u001b[F',
      '\u001b[3~',
      '\u001b[1;5D',
    ];
    const r = run(`tk_${keys.join('')}abc\r`);
    expect(r).toMatchObject({ value: 'tk_abc', done: 'submit' });
    expect(r.echo).toBe('******');
  });

  it('keeps a bracketed paste and drops its markers', () => {
    const r = run(`\u001b[200~${TOKEN}\u001b[201~\r`);
    expect(r).toMatchObject({ value: TOKEN, done: 'submit' });
  });

  it('handles an escape sequence split across reads', () => {
    expect(run('tk_', '\u001b', '[', '3', '~', 'x\r').value).toBe('tk_x');
    expect(run('tk_\u001b[20', '0~ab\u001b[2', '01~\r').value).toBe('tk_ab');
  });

  it('lets Enter and Ctrl+C through after a lone Esc', () => {
    expect(run('tk_a\u001b\r')).toMatchObject({ value: 'tk_a', done: 'submit' });
    expect(run('tk_a\u001b\u0003').done).toBe('cancel');
  });

  it('erases with Backspace and Ctrl+U without echoing characters', () => {
    const r = run('tk_ab\u007f', 'c\u0015xy\r');
    expect(r).toMatchObject({ value: 'xy', done: 'submit' });
    expect(r.echo).toMatch(/^[*\b ]*$/);
  });

  it('never echoes any typed character', () => {
    const r = run(`\u001b[200~${TOKEN}\u001b[201~\u007f\u001b[D\r`);
    for (const ch of new Set(TOKEN)) expect(r.echo).not.toContain(ch);
  });
});
