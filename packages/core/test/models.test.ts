import { describe, expect, it } from 'vitest';
import { modelLabel } from '../src/models.js';

describe('modelLabel', () => {
  it('drops a compact release date', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  it('drops a dashed release date', () => {
    expect(modelLabel('gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(modelLabel('o3-2025-04-16')).toBe('o3');
  });

  it('keeps ids whose tail is not a full date', () => {
    expect(modelLabel('gemini-2.5-pro-preview-05-06')).toBe('gemini-2.5-pro-preview-05-06');
    expect(modelLabel('grok-4.20-0309-reasoning')).toBe('grok-4.20-0309-reasoning');
    expect(modelLabel('gpt-5.5')).toBe('gpt-5.5');
  });
});
