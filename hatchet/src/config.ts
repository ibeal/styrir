import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk';

// The statuses `sandbox-run` resolves a model for. `build-phase` runs as "building",
// `review-phase` runs as "reviewing" — there is no third phase.
export type ModelStatus = 'building' | 'reviewing';

// Exactly 4 model strings per provider, indexed by tier (0 = cheapest/fastest, 3 = strongest).
export type ModelTiers = [string, string, string, string];

export type ModelsConfig = {
  defaultProvider: string;
  defaultComplexity: Partial<Record<ModelStatus, number>>;
  tiers: Record<string, ModelTiers>;
};

export type RepoConfig = {
  checkout: string;
  pushUrl: string;
  trunk: string;
  forge: 'github' | 'azure-devops';
  buildSpec: string;
  reviewSpec: string;
  verify: string;
  // Optional per-repo override of the global models.defaultComplexity, same shape.
  defaultComplexity?: Partial<Record<ModelStatus, number>>;
};

export type StyrirConfig = {
  maxReviewRounds: number;
  maxBuildContinuations: number;
  maxConcurrentSandboxes: number;
  pollIntervalSeconds: number;
  models: ModelsConfig;
  repos: Record<string, RepoConfig>;
};

const configPath = process.env.STYRIR_CONFIG ?? resolve(process.cwd(), 'styrir.config.json');

export const config: StyrirConfig = JSON.parse(readFileSync(configPath, 'utf8'));

export function repoConfig(slug: string): RepoConfig {
  const repo = config.repos[slug];
  if (!repo) throw new Error(`no repo "${slug}" in ${configPath}`);
  return repo;
}

export function statusForKind(kind: 'build' | 'review'): ModelStatus {
  return kind === 'build' ? 'building' : 'reviewing';
}

export type ResolvedModel = { tier: number; provider: string; model: string };

// Pure so it is unit-testable without a styrir.config.json on disk. `resolveModel` below is
// the thin wrapper that feeds it the loaded config.
export function resolveModelFrom(
  models: ModelsConfig,
  repo: Pick<RepoConfig, 'defaultComplexity'>,
  status: ModelStatus,
  complexity: number | null,
  provider: string | null,
): ResolvedModel {
  const tier = complexity ?? repo.defaultComplexity?.[status] ?? models.defaultComplexity[status];
  if (tier === undefined || tier === null) {
    throw new NonRetryableError(`styrir: no defaultComplexity for status "${status}"`);
  }
  const resolvedProvider = provider ?? models.defaultProvider;
  const tierModels = models.tiers[resolvedProvider];
  if (!tierModels) {
    throw new NonRetryableError(`styrir: unknown provider "${resolvedProvider}" in models.tiers`);
  }
  const model = tierModels[tier];
  if (!model) {
    throw new NonRetryableError(`styrir: no tier ${tier} model for provider "${resolvedProvider}"`);
  }
  return { tier, provider: resolvedProvider, model };
}

export function resolveModel(input: {
  repoSlug: string;
  status: ModelStatus;
  complexity: number | null;
  provider: string | null;
}): ResolvedModel {
  return resolveModelFrom(config.models, repoConfig(input.repoSlug), input.status, input.complexity, input.provider);
}
