import { execFile } from 'node:child_process';

export type ExecResult = { stdout: string; stderr: string };

// argv-only, never a shell: no quoting, no substitution, no pipelines. Multi-line
// text goes in over stdin, which is how skald/heimr want it anyway.
export function run(cmd: string, args: string[], opts: { stdin?: string; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${cmd} ${args.join(' ')} failed: ${err.message}\n${stderr}`));
          return;
        }
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
