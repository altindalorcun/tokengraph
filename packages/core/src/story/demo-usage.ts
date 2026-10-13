import { addDays, dateKey } from '../dates.js';
import { toGraphDaysByFamily, type FamilyGraphDay, type ModelDayRow } from '../graph-days.js';
import type { TokenCounts } from '../tokens.js';

/** mulberry32: a tiny seeded PRNG in [0, 1), so sample data looks the same on every render. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The account the sample cards are played as: GitHub's own example user, so a sample
 * card never shows a real person's name or numbers.
 */
export const DEMO_HANDLE = 'octocat';

interface DemoAgent {
  /** Model ids with their usual share of this agent's day. */
  models: readonly (readonly [string, number])[];
  /** Where in the year (0 oldest, 1 today) this agent was used most, so the hues drift like a real year. */
  peak: number;
  weight: number;
}

const AGENTS: readonly DemoAgent[] = [
  {
    models: [['claude-opus-5-5', 0.55], ['claude-sonnet-5', 0.35], ['claude-haiku-4-5', 0.1]],
    peak: 0.92,
    weight: 1,
  },
  {
    models: [['gpt-5.5', 0.6], ['gpt-5.3-codex', 0.4]],
    peak: 0.22,
    weight: 0.9,
  },
  {
    models: [['gemini-3-pro', 0.7], ['gemini-2.5-flash', 0.3]],
    peak: 0.5,
    weight: 0.75,
  },
  {
    models: [['deepseek-v3.2', 0.4], ['qwen3-coder', 0.3], ['glm-4.6', 0.15], ['kimi-k2', 0.15]],
    peak: 0.7,
    weight: 0.7,
  },
];

export interface DemoUsage {
  days: FamilyGraphDay[];
  /** The per-day, per-model rows everything else is built from. */
  modelRows: ModelDayRow[];
  endDate: string;
}

/** Splits weighted tokens into raw counts that weigh back to the same number (cache read counts 0.1). */
function countsFor(weighted: number): TokenCounts {
  return {
    inputTokens: Math.round(weighted * 0.15),
    outputTokens: Math.round(weighted * 0.1),
    cacheCreationTokens: Math.round(weighted * 0.25),
    cacheReadTokens: Math.round(weighted * 5),
  };
}

/**
 * A year of made-up usage for `DEMO_HANDLE`, spread across agents and the models behind them
 * (Claude, GPT, Gemini, DeepSeek, Qwen, GLM, Kimi). Deterministic: the same day always gives the same year.
 * Never real data.
 */
export function demoUsage(now: Date, dayCount = 371, seed = 20261003): DemoUsage {
  const random = seededRandom(seed);
  const modelRows: ModelDayRow[] = [];

  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    const day = addDays(now, -offset);
    const date = dateKey(day, 'UTC');
    const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    if (random() < (weekend ? 0.55 : 0.16)) continue;

    const position = 1 - offset / dayCount;
    const volume = (0.3 + 0.7 * position) * (300_000 + random() ** 2 * 11_000_000);

    // Each agent's pull today: strongest around its peak, never quite zero, sometimes skipped.
    const pulls = AGENTS.map((agent) => {
      const near = Math.exp(-(((position - agent.peak) / 0.2) ** 2));
      const skipped = random() < 0.62 - 0.5 * near;
      return skipped ? 0 : agent.weight * (0.12 + near) * (0.4 + random() * 1.2);
    });
    const pullTotal = pulls.reduce((sum, pull) => sum + pull, 0);
    if (pullTotal <= 0) continue;

    AGENTS.forEach((agent, index) => {
      const agentWeighted = (volume * pulls[index]!) / pullTotal;
      if (agentWeighted < 20_000) return;
      // The day's main model is drawn by share, so any of an agent's models can lead a day; it
      // always runs, the others only on some days.
      const total = agent.models.reduce((sum, [, share]) => sum + share, 0);
      let pick = random() * total;
      let main = 0;
      for (let m = 0; m < agent.models.length; m += 1) {
        pick -= agent.models[m]![1];
        if (pick < 0) {
          main = m;
          break;
        }
      }
      const shares = agent.models.map(([, share], m) => (m === main || random() < 0.35 ? share * (0.5 + random()) : 0));
      const shareTotal = shares.reduce((sum, share) => sum + share, 0);
      agent.models.forEach(([model], m) => {
        const modelWeighted = (agentWeighted * shares[m]!) / shareTotal;
        if (modelWeighted <= 0) return;
        const modelCounts = countsFor(modelWeighted);
        modelRows.push({ date, model, ...modelCounts });
      });
    });
  }

  return { days: toGraphDaysByFamily(modelRows), modelRows, endDate: dateKey(now, 'UTC') };
}
