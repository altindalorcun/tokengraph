import { describe, expect, it } from 'vitest';
import {
  FAMILY_HUES,
  FAMILY_RAMPS,
  FAMILY_RAMPS_LIGHT,
  CLAUDE_RAMP_DARK,
  CLAUDE_RAMP_LIGHT,
  GRAPH_RAMP_DARK,
  GRAPH_RAMP_LIGHT,
  cellColor,
  legendRamp,
} from '../src/graph-colors.js';
import { MODEL_FAMILIES } from '../src/model-makers.js';

describe('family ramps', () => {
  it('gives every family a six-step ramp in both themes, with distinct tops', () => {
    for (const family of MODEL_FAMILIES) {
      expect(FAMILY_RAMPS[family]).toHaveLength(6);
      expect(FAMILY_RAMPS_LIGHT[family]).toHaveLength(6);
    }
    expect(new Set(MODEL_FAMILIES.map((family) => FAMILY_RAMPS[family][5])).size).toBe(MODEL_FAMILIES.length);
    expect(new Set(MODEL_FAMILIES.map((family) => FAMILY_RAMPS_LIGHT[family][5])).size).toBe(MODEL_FAMILIES.length);
  });

  it('keeps Claude orange and GPT blue exactly as before', () => {
    expect(FAMILY_RAMPS.claude).toEqual(CLAUDE_RAMP_DARK);
    expect(FAMILY_RAMPS_LIGHT.claude).toEqual(CLAUDE_RAMP_LIGHT);
    expect(FAMILY_RAMPS.gpt).toEqual(['#292524', '#172554', '#1e40af', '#1d4ed8', '#2563eb', '#60a5fa']);
    expect(FAMILY_HUES.claude).toBe('#fb923c');
  });
});

describe('cellColor', () => {
  it('paints a quiet day pale on light and dark on dark surfaces', () => {
    expect(cellColor(1, { theme: 'dark' })).toBe(GRAPH_RAMP_DARK[1]);
    expect(cellColor(1, { theme: 'light' })).toBe(GRAPH_RAMP_LIGHT[1]);
  });

  it('ignores the family in single-hue mode', () => {
    expect(cellColor(3, { family: 'gpt' })).toBe(GRAPH_RAMP_DARK[3]);
  });

  it('takes the family ramp in per-model mode, keeping darkness as volume', () => {
    expect(cellColor(3, { colorMode: 'per-model', family: 'qwen' })).toBe(FAMILY_RAMPS.qwen[3]);
    expect(cellColor(3, { colorMode: 'per-model', family: 'kimi', theme: 'light' })).toBe(FAMILY_RAMPS_LIGHT.kimi[3]);
  });

  it('never returns a family hue for level 0, and lets a surface supply its own empty cell', () => {
    expect(cellColor(0, { colorMode: 'per-model', family: 'gemini' })).toBe(GRAPH_RAMP_DARK[0]);
    expect(cellColor(0, { empty: '#21262d' })).toBe('#21262d');
  });
});

describe('legendRamp', () => {
  it('has one swatch per level', () => {
    expect(legendRamp('dark')).toHaveLength(6);
    expect(legendRamp('light')).toHaveLength(6);
  });
});
