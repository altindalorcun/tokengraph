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

  it('keeps the eight published hues exactly as they were', () => {
    expect(FAMILY_RAMPS.gemini).toEqual(['#292524', '#2e1065', '#5b21b6', '#6d28d9', '#7c3aed', '#a78bfa']);
    expect(FAMILY_RAMPS.deepseek[4]).toBe('#0d9488');
    expect(FAMILY_RAMPS.qwen[4]).toBe('#db2777');
    expect(FAMILY_RAMPS.glm[4]).toBe('#16a34a');
    expect(FAMILY_RAMPS.kimi[4]).toBe('#ca8a04');
    expect(FAMILY_RAMPS.other).toEqual(['#292524', '#1e293b', '#334155', '#475569', '#64748b', '#cbd5e1']);
    expect(FAMILY_RAMPS_LIGHT.other[4]).toBe('#64748b');
  });

  it('starts at the surface and climbs in lightness (dark) or darkness (light) for every family', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    for (const family of MODEL_FAMILIES) {
      const dark = FAMILY_RAMPS[family];
      const light = FAMILY_RAMPS_LIGHT[family];
      expect(dark[0]).toBe('#292524');
      expect(['#e7e5e4', '#ebe9e6']).toContain(light[0]); // Claude's light ramp has always used the second
      for (let level = 2; level <= 5; level += 1) {
        expect(lum(dark[level]!), `${family} dark ${level}`).toBeGreaterThan(lum(dark[level - 1]!));
        expect(lum(light[level]!), `${family} light ${level}`).toBeLessThan(lum(light[level - 1]!));
      }
    }
  });

  it('gives every family its own legend swatch in both themes', () => {
    expect(new Set(MODEL_FAMILIES.map((family) => FAMILY_RAMPS[family][4])).size).toBe(MODEL_FAMILIES.length);
    expect(new Set(MODEL_FAMILIES.map((family) => FAMILY_RAMPS_LIGHT[family][4])).size).toBe(MODEL_FAMILIES.length);
    expect(FAMILY_HUES.llama).toBe(FAMILY_RAMPS.llama[5]);
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
