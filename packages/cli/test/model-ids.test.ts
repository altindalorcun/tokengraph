import { describe, expect, it } from 'vitest';
import { canonicalModelId, MAX_MODEL_NAME_LENGTH } from '../src/adapters/model-ids.js';

describe('canonicalModelId', () => {
  it.each([
    // [providerId, modelId, expected]
    ['anthropic', 'claude-sonnet-4-5', 'claude-sonnet-4-5'],
    ['anthropic', 'claude-opus-4-5-20251101', 'claude-opus-4-5-20251101'],
    ['opencode', 'claude-haiku-4-5', 'claude-haiku-4-5'],
    ['github-copilot', 'claude-opus-4.7', 'claude-opus-4-7'],
    ['openrouter', 'anthropic/claude-opus-4.5', 'claude-opus-4-5'],
    ['cline', 'anthropic/claude-sonnet-4.5', 'claude-sonnet-4-5'],
    ['openrouter', 'openai/gpt-5.4', 'gpt-5.4'],
    ['openrouter', 'google/gemini-2.5-pro', 'gemini-2.5-pro'],
    ['amazon-bedrock', 'us.anthropic.claude-opus-4-7', 'claude-opus-4-7'],
    ['bedrock', 'global.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5-20251001'],
    ['bedrock', 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5-20250929'],
    ['google-vertex-anthropic', 'claude-sonnet-4-5@20250929', 'claude-sonnet-4-5'],
    ['vertex', 'claude-opus-4-8@default', 'claude-opus-4-8'],
    ['openai', 'gpt-5.3-codex', 'gpt-5.3-codex'],
    [null, 'gemini-3-flash-preview', 'gemini-3-flash-preview'],
  ])('%s / %s → %s', (provider, model, expected) => {
    expect(canonicalModelId(provider, model)).toBe(expected);
  });

  it('leaves open-weight and unknown ids exactly as given', () => {
    expect(canonicalModelId('ollama', 'qwen3-coder:30b')).toBe('qwen3-coder:30b');
    expect(canonicalModelId('openrouter', 'qwen/qwen3-coder')).toBe('qwen/qwen3-coder');
    expect(canonicalModelId('lmstudio', 'DeepSeek-R1-Distill')).toBe('DeepSeek-R1-Distill');
    expect(canonicalModelId('custom', 'my-org/claude-finetune')).toBe('my-org/claude-finetune');
  });

  it('only strips the Bedrock and Vertex decorations for those providers', () => {
    expect(canonicalModelId('ollama', 'us.anthropic.claude-opus-4-7')).toBe('us.anthropic.claude-opus-4-7');
    expect(canonicalModelId('ollama', 'claude-sonnet-4-5@20250929')).toBe('claude-sonnet-4-5@20250929');
  });

  it('falls back to unknown and caps length', () => {
    expect(canonicalModelId('anthropic', null)).toBe('unknown');
    expect(canonicalModelId(null, '   ')).toBe('unknown');
    expect(canonicalModelId('ollama', 'x'.repeat(300))).toHaveLength(MAX_MODEL_NAME_LENGTH);
  });

  it('treats a filesystem path or ARN-shaped model id as unknown, never uploading it verbatim', () => {
    expect(canonicalModelId('ollama', '/Users/secretuser/models/my-model.gguf')).toBe('unknown');
    expect(canonicalModelId('ollama', '~/models/my-model.gguf')).toBe('unknown');
    expect(canonicalModelId('bedrock', 'arn:aws:bedrock:us-east-1:123456789012:model/anthropic.claude-opus-4-7')).toBe('unknown');
    expect(canonicalModelId('lmstudio', 'C:\\Users\\secretuser\\models\\my-model.gguf')).toBe('unknown');
    expect(canonicalModelId('lmstudio', 'C:/Users/secretuser/models/my-model.gguf')).toBe('unknown');
    expect(canonicalModelId('ollama', '/home/secretuser/projects/model')).toBe('unknown');
  });
});
