import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type RepoConfig = {
  checkout: string;
  pushUrl: string;
  trunk: string;
  buildSpec: string;
  reviewSpec: string;
  verify: string;
};

export type StyrirConfig = {
  maxReviewRounds: number;
  maxBuildContinuations: number;
  maxConcurrentSandboxes: number;
  pollIntervalSeconds: number;
  repos: Record<string, RepoConfig>;
};

const configPath = process.env.STYRIR_CONFIG ?? resolve(process.cwd(), 'styrir.config.json');

export const config: StyrirConfig = JSON.parse(readFileSync(configPath, 'utf8'));

export function repoConfig(slug: string): RepoConfig {
  const repo = config.repos[slug];
  if (!repo) throw new Error(`no repo "${slug}" in ${configPath}`);
  return repo;
}
