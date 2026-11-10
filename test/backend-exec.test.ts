import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenkiBackend } from '../src/backend.js';

const { run, get, resume, waitReady, session } = vi.hoisted(() => {
  const run = vi.fn();
  const resume = vi.fn();
  const waitReady = vi.fn();
  const session = { state: 'RUNNING', run, resume, waitReady };
  return { run, get: vi.fn(), resume, waitReady, session };
});

vi.mock('../src/sdk.js', () => ({ getTenkiClient: () => ({ get }) }));

const handle = { sandboxId: 'exec-test' };
const encoder = new TextEncoder();

beforeEach(() => {
  vi.resetAllMocks();
  session.state = 'RUNNING';
  get.mockResolvedValue(session);
  run.mockResolvedValue({
    exitCode: 0,
    stdout: encoder.encode('stdout'),
    stderr: encoder.encode('stderr'),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tenkiBackend.exec', () => {
  it('passes the command budget, cancellation signal, and execution options to Tenki', async () => {
    const result = await tenkiBackend.exec(handle, 'printf hello', {
      attemptTimeoutMs: 1234,
      cwd: '/workspace',
      env: { EXAMPLE: 'value' },
      user: 'root',
      noRetry: true,
    });

    expect(run).toHaveBeenCalledExactlyOnceWith(['bash', '-c', 'printf hello'], {
      timeoutMs: 1234,
      signal: expect.any(AbortSignal),
      cwd: '/workspace',
      env: { EXAMPLE: 'value' },
      privileged: true,
    });
    expect(result).toEqual({ exitCode: 0, stdout: 'stdout', stderr: 'stderr' });
  });

  it('enforces the default five-minute guest budget', async () => {
    await tenkiBackend.exec(handle, 'true');
    expect(run.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 300_000 });
  });

  it.each([0, 137])('reports timedOut as failure even with exit code %i', async (exitCode) => {
    run.mockResolvedValue({
      exitCode,
      stdout: encoder.encode('partial output'),
      stderr: encoder.encode('partial error'),
      timedOut: true,
    });

    await expect(
      tenkiBackend.exec(handle, 'sleep 10', { attemptTimeoutMs: 1000 }),
    ).resolves.toEqual({
      exitCode: 124,
      stdout: 'partial output',
      stderr: 'partial error\ntenki exec: command timed out after 1000ms',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary nonzero exits', async () => {
    run.mockResolvedValue({
      exitCode: 42,
      stdout: new Uint8Array(),
      stderr: encoder.encode('failure'),
      timedOut: false,
    });
    await expect(tenkiBackend.exec(handle, 'exit 42')).resolves.toEqual({
      exitCode: 42,
      stdout: '',
      stderr: 'failure',
    });
  });

  it('aborts the guest run when the outer attempt expires', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    run.mockImplementation((_argv, opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      });
    });
    const result = tenkiBackend.exec(handle, 'sleep 10', {
      attemptTimeoutMs: 100,
      noRetry: true,
    });
    const rejected = expect(result).rejects.toThrow('per-attempt timeout after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not launch a command if resolving the session outlives the attempt', async () => {
    vi.useFakeTimers();
    get.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(session), 200)));
    const result = tenkiBackend.exec(handle, 'touch marker', {
      attemptTimeoutMs: 100,
      noRetry: true,
    });
    const rejected = expect(result).rejects.toThrow('per-attempt timeout after 100ms');
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
    expect(run).not.toHaveBeenCalled();
  });

  it('resumes a paused session before execution', async () => {
    session.state = 'PAUSED';
    await tenkiBackend.exec(handle, 'true');
    expect(resume).toHaveBeenCalledTimes(1);
    expect(waitReady).toHaveBeenCalledExactlyOnceWith(300_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
