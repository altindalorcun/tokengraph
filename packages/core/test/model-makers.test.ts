import { describe, expect, it } from 'vitest';
import { AGENT_LOGOS } from '../src/agent-logos.js';
import { MAKER_LOGOS } from '../src/maker-logos.js';
import { FAMILY_LABELS, FAMILY_LOGOS, MODEL_FAMILIES, familyForMaker, modelFamily, modelMaker, displayModelName } from '../src/model-makers.js';

describe('modelFamily', () => {
  it.each([
    ['claude-opus-5-5', 'claude'],
    ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'claude'],
    ['gpt-5.5', 'gpt'],
    ['gpt-5.3-codex', 'gpt'],
    ['o3-mini', 'gpt'],
    ['gemini-3-pro', 'gemini'],
    ['gemma-3-27b', 'gemini'],
    ['deepseek-v3.2', 'deepseek'],
    ['deepseek-r1-distill-llama-70b', 'deepseek'],
    ['qwen3-coder', 'qwen'],
    ['openrouter/qwen/qwen3-max', 'qwen'],
    ['glm-4.6', 'glm'],
    ['kimi-k2', 'kimi'],
    ['moonshot-v1-8k', 'kimi'],
    ['llama-3.3-70b', 'llama'],
    ['bedrock/meta.llama3-70b-instruct-v1:0', 'llama'],
    ['grok-4', 'grok'],
    ['grok-code-fast-1', 'grok'],
    ['cursor-grok-4.5-medium', 'grok'],
    ['composer-2.5-fast', 'composer'],
    ['composer-2', 'composer'],
    ['cursor-small', 'composer'],
    ['mistral-large', 'mistral'],
    ['devstral', 'mistral'],
    ['minimax-m2.5', 'minimax'],
    ['minimax/minimax-m2.5', 'minimax'],
    ['auto', 'other'],
    ['default', 'other'],
    ['agent_review', 'other'],
    ['premium', 'other'],
    ['some-custom-model', 'other'],
    ['opus-mt-en-de', 'other'],
    ['', 'other'],
  ])('%s belongs to %s', (id, family) => {
    expect(modelFamily(id)).toBe(family);
  });

  it('maps an unknown maker to other', () => {
    expect(familyForMaker(null)).toBe('other');
    expect(familyForMaker('cohere')).toBe('other');
  });

  it('lists families in legend order with a label each', () => {
    expect(MODEL_FAMILIES).toEqual(['claude', 'gpt', 'gemini', 'deepseek', 'qwen', 'glm', 'kimi', 'grok', 'composer', 'mistral', 'llama', 'minimax', 'other']);
    for (const family of MODEL_FAMILIES) expect(FAMILY_LABELS[family]).toBeTruthy();
    expect(FAMILY_LABELS.composer).toBe('Composer');
    expect(FAMILY_LABELS.gpt).toBe('GPT');
    expect(FAMILY_LABELS.other).toBe('Other models');
  });

  it('draws Claude, GPT and Gemini with the agents’ marks, the rest with the makers’, and other with none', () => {
    expect(FAMILY_LOGOS.claude).toBe(AGENT_LOGOS['claude-code']);
    expect(FAMILY_LOGOS.gpt).toBe(AGENT_LOGOS['codex-cli']);
    expect(FAMILY_LOGOS.gemini).toBe(AGENT_LOGOS['gemini-cli']);
    expect(FAMILY_LOGOS.deepseek).toBe(MAKER_LOGOS.deepseek);
    expect(FAMILY_LOGOS.qwen).toBe(MAKER_LOGOS.qwen);
    expect(FAMILY_LOGOS.glm).toBe(MAKER_LOGOS.zhipu);
    expect(FAMILY_LOGOS.kimi).toBe(MAKER_LOGOS.moonshot);
    expect(FAMILY_LOGOS.grok).toBe(MAKER_LOGOS.xai);
    expect(FAMILY_LOGOS.composer).toBe(AGENT_LOGOS.cursor);
    expect(FAMILY_LOGOS.mistral).toBe(MAKER_LOGOS.mistral);
    expect(FAMILY_LOGOS.llama).toBe(MAKER_LOGOS.meta);
    expect(FAMILY_LOGOS.minimax).toBe(MAKER_LOGOS.minimax);
    expect(FAMILY_LOGOS.other).toBeUndefined();
  });

  it('still finds the maker for a provider-prefixed id', () => {
    expect(modelMaker('anthropic/claude-opus-4.1')).toBe('anthropic');
  });
});

describe('displayModelName', () => {
  it.each([
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['claude-opus-5', 'Claude Opus 5'],
    ['claude-haiku-4-5', 'Claude Haiku 4.5'],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ['claude-3-5-sonnet-20241022', 'Claude Sonnet 3.5'],
    ['claude-opus-4.1', 'Claude Opus 4.1'],
    ['anthropic/claude-opus-4.1', 'Claude Opus 4.1'],
    ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'Claude Sonnet 3.5'],
    ['claude-sonnet', 'Claude Sonnet'],
    ['deepseek-v4.1-flash', 'deepseek-v4.1-flash'],
    ['gpt-6-luna', 'gpt-6-luna'],
    ['gpt-5-20250807', 'gpt-5'],
    ['auto', 'Cursor Auto'],
    ['default', 'Cursor Auto'],
    ['composer-2.5-fast', 'composer-2.5-fast'],
    ['claude-unknown-9', 'Claude Unknown 9'],
  ])('%s is shown as %s', (id, name) => {
    expect(displayModelName(id)).toBe(name);
  });

  it.each([
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ['claude-fable-5-1', 'Claude Fable 5.1'],
    ['claude-mythos-5', 'Claude Mythos 5'],
    ['claude-nova-6-2', 'Claude Nova 6.2'],
    ['claude-3-5-sonnet-20241022', 'Claude Sonnet 3.5'],
    ['us.anthropic.claude-opus-5-5-v1:0', 'Claude Opus 5.5'],
    ['claude-opus-4-5-thinking', 'Claude Opus 4.5'],
    ['claude-2-1', 'Claude 2.1'],
    ['gpt-6-luna', 'gpt-6-luna'],
    ['auto', 'Cursor Auto'],
  ])('names every Claude tier and version: %s', (id, name) => {
    expect(displayModelName(id)).toBe(name);
  });
});
