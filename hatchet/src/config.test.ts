import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk';
import { resolveModelFrom, type ModelsConfig, type RepoConfig } from './config.js';

const models: ModelsConfig = {
  defaultProvider: 'anthropic',
  defaultComplexity: { building: 2, reviewing: 1 },
  tiers: {
    anthropic: ['haiku', 'sonnet', 'sonnet', 'opus'],
    openai: ['mini', 'gpt', 'gpt', 'pro'],
  },
};

function repo(defaultComplexity?: Pick<RepoConfig, 'defaultComplexity'>['defaultComplexity']): Pick<RepoConfig, 'defaultComplexity'> {
  return { defaultComplexity };
}

test('ticket complexity wins over every default', () => {
  const resolved = resolveModelFrom(models, repo({ building: 3 }), 'building', 0, null);
  assert.equal(resolved.tier, 0);
  assert.equal(resolved.provider, 'anthropic');
  assert.equal(resolved.model, 'haiku');
});

test('falls back to repo defaultComplexity when ticket has none', () => {
  const resolved = resolveModelFrom(models, repo({ building: 3 }), 'building', null, null);
  assert.equal(resolved.tier, 3);
  assert.equal(resolved.model, 'opus');
});

test('falls back to global defaultComplexity when repo has no override', () => {
  const resolved = resolveModelFrom(models, repo(undefined), 'reviewing', null, null);
  assert.equal(resolved.tier, 1);
  assert.equal(resolved.model, 'sonnet');
});

test('ticket provider wins over defaultProvider', () => {
  const resolved = resolveModelFrom(models, repo(undefined), 'building', 1, 'openai');
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.model, 'gpt');
});

test('status with no default anywhere fails, never falls back to the spec model', () => {
  const noDefaults: ModelsConfig = { ...models, defaultComplexity: {} };
  assert.throws(
    () => resolveModelFrom(noDefaults, repo(undefined), 'reviewing', null, null),
    (err: unknown) => err instanceof NonRetryableError && /defaultComplexity/.test((err as Error).message),
  );
});

test('unknown provider fails, naming the provider', () => {
  assert.throws(
    () => resolveModelFrom(models, repo(undefined), 'building', 1, 'unknown-llm-co'),
    (err: unknown) => err instanceof NonRetryableError && /unknown-llm-co/.test((err as Error).message),
  );
});

test('missing tier entry in an otherwise known provider fails, naming the tier', () => {
  const shortTiers: ModelsConfig = { ...models, tiers: { anthropic: ['haiku', 'sonnet', '', 'opus'] as unknown as ModelsConfig['tiers']['anthropic'] } };
  assert.throws(
    () => resolveModelFrom(shortTiers, repo(undefined), 'building', 2, null),
    (err: unknown) => err instanceof NonRetryableError && /tier 2/.test((err as Error).message),
  );
});
