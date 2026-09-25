import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import type { Context } from '@hatchet-dev/typescript-sdk';

export type ExecResult = { stdout: string; stderr: string };

// Leaf tasks call run() from helpers several frames deep, so the task context travels
// implicitly. Logs go to the engine this worker is connected to (the local hatchet-lite)
// and appear on the task run's Logs tab; nothing leaves the machine.
const taskContext = new AsyncLocalStorage<Context<any>>();

export function logged<I, O>(fn: (input: I, ctx: Context<I>) => Promise<O>): (input: I, ctx: Context<I>) => Promise<O> {
  return (input, ctx) => taskContext.run(ctx, () => fn(input, ctx));
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const ctx = taskContext.getStore();
  if (!ctx) return;
  void ctx.logger[level](message).catch(() => {});
}

const STDERR_TAIL = 1500;

// argv-only, never a shell: no quoting, no substitution, no pipelines. Multi-line
// text goes in over stdin, which is how skald/heimr want it anyway.
export function run(cmd: string, args: string[], opts: { stdin?: string; cwd?: string } = {}): Promise<ExecResult> {
  const line = `${cmd} ${args.join(' ')}`;
  const startedAt = Date.now();
  log('info', `$ ${line}${opts.cwd ? `  (cwd ${opts.cwd})` : ''}`);
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const ms = Date.now() - startedAt;
        const tail = stderr.trim().slice(-STDERR_TAIL);
        if (err) {
          log('error', `✗ ${cmd} (${ms}ms): ${err.message}${tail ? `\n${tail}` : ''}`);
          reject(new Error(`${line} failed: ${err.message}\n${stderr}`));
          return;
        }
        log('info', `✓ ${cmd} (${ms}ms, ${stdout.length}B stdout)${tail ? `\nstderr: ${tail}` : ''}`);
        resolvePromise({ stdout, stderr });
      },
    );
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}

export async function runJson<T>(cmd: string, args: string[], opts: { stdin?: string; cwd?: string } = {}): Promise<T> {
  const { stdout } = await run(cmd, args, opts);
  return JSON.parse(stdout) as T;
}
