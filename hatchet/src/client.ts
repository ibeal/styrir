import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Hatchet } from '@hatchet-dev/typescript-sdk';

// Explicit HATCHET_CLIENT_* env wins. Otherwise reuse the `hatchet` CLI's profile
// (~/.hatchet/profiles.yaml, HATCHET_PROFILE selects one) so the worker and the CLI
// always talk to the same instance with the same token.
function fromCliProfile(): { token: string; host_port: string; tls_config: { tls_strategy: 'none' | 'tls' } } | null {
  const path = join(homedir(), '.hatchet', 'profiles.yaml');
  if (!existsSync(path)) return null;
  const yaml = readFileSync(path, 'utf8');
  const wanted = process.env.HATCHET_PROFILE ?? /^defaultprofile:\s*(\S+)/m.exec(yaml)?.[1] ?? 'local';
  const block = new RegExp(`^ {4}${wanted}:\\n((?: {8}.*\\n?)+)`, 'm').exec(yaml)?.[1];
  if (!block) return null;
  const field = (k: string) => new RegExp(`^ {8}${k}:\\s*(\\S+)`, 'm').exec(block)?.[1];
  const token = field('token');
  const host_port = field('grpchostport');
  if (!token || !host_port) return null;
  return { token, host_port, tls_config: { tls_strategy: field('tlsstrategy') === 'tls' ? 'tls' : 'none' } };
}

// The SDK defaults to TLS when handed a bare token; `hatchet server start` speaks plain gRPC on
// 7077, so default to none unless the env says otherwise.
export const hatchet = Hatchet.init(
  process.env.HATCHET_CLIENT_TOKEN
    ? {
        token: process.env.HATCHET_CLIENT_TOKEN,
        host_port: process.env.HATCHET_CLIENT_HOST_PORT ?? 'localhost:7077',
        tls_config: { tls_strategy: process.env.HATCHET_CLIENT_TLS_STRATEGY === 'tls' ? 'tls' : 'none' },
      }
    : fromCliProfile() ?? undefined,
);
