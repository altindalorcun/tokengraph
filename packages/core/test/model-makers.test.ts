import { describe, expect, it } from 'vitest';
import { AGENT_LOGOS } from '../src/agent-logos.js';
import { MAKER_LOGOS } from '../src/maker-logos.js';
import { FAMILY_LABELS, FAMILY_LOGOS, MODEL_FAMILIES, familyForMaker, modelFamily, modelMaker } from '../src/model-makers.js';

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
    ['llama-3.3-70b', 'other'],
    ['bedrock/meta.llama3-70b-instruct-v1:0', 'other'],
    ['grok-4', 'other'],
    ['some-custom-model', 'other'],
    ['opus-mt-en-de', 'other'],
    ['', 'other'],
  ])('%s belongs to %s', (id, family) => {
    expect(modelFamily(id)).toBe(family);
  });

  it('maps an unknown maker to other', () => {
    expect(familyForMaker(null)).toBe('other');
    expect(familyForMaker('mistral')).toBe('other');
  });

  it('lists families in legend order with a label each', () => {
    expect(MODEL_FAMILIES).toEqual(['claude', 'gpt', 'gemini', 'deepseek', 'qwen', 'glm', 'kimi', 'other']);
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
    expect(FAMILY_LOGOS.other).toBeUndefined();
  });

  it('still finds the maker for a provider-prefixed id', () => {
    expect(modelMaker('anthropic/claude-opus-4.1')).toBe('anthropic');
  });
});
