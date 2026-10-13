import { userInfo } from 'node:os';
import { buildStory, dateKey, type CostRow, type DailyModelUsage, type ModelDayTotals, type StoryData, type StoryRange } from '@tokengraph/core';
import { readConfig, type CliConfig } from '../config.js';
import { readLedger } from '../ledger.js';
import { ledgerPath } from '../paths.js';
import { combinedUsage } from '../publish/machines.js';
import { readMachinesCache } from '../publish/machines-cache.js';

const addNullable = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

/** Per model-day rows for the cards and per model-day-tier rows for cost, summed over sources and machines. */
export function storyRows(usage: readonly DailyModelUsage[]): { rows: ModelDayTotals[]; costRows: CostRow[] } {
  const rows = new Map<string, ModelDayTotals>();
  const costRows = new Map<string, CostRow>();
  for (const entry of usage) {
    const c = entry.counts;
    const rowKey = `${entry.date}|${entry.model}`;
    const row = rows.get(rowKey) ?? { date: entry.date, model: entry.model, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    row.inputTokens += c.inputTokens;
    row.outputTokens += c.outputTokens;
    row.cacheCreationTokens += c.cacheCreationTokens;
    row.cacheReadTokens += c.cacheReadTokens;
    rows.set(rowKey, row);

    const costKey = `${rowKey}|${entry.pricingTier}`;
    const cost = costRows.get(costKey);
    if (!cost) {
      costRows.set(costKey, {
        date: entry.date,
        model: entry.model,
        pricingTier: entry.pricingTier,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cacheReadTokens: c.cacheReadTokens,
        cacheCreationTokens: c.cacheCreationTokens,
        cacheCreation5mTokens: c.cacheCreation5mTokens,
        cacheCreation1hTokens: c.cacheCreation1hTokens,
      });
    } else {
      cost.inputTokens += c.inputTokens;
      cost.outputTokens += c.outputTokens;
      cost.cacheReadTokens += c.cacheReadTokens;
      cost.cacheCreationTokens += c.cacheCreationTokens;
      cost.cacheCreation5mTokens = addNullable(cost.cacheCreation5mTokens, c.cacheCreation5mTokens);
      cost.cacheCreation1hTokens = addNullable(cost.cacheCreation1hTokens, c.cacheCreation1hTokens);
    }
  }
  return { rows: [...rows.values()], costRows: [...costRows.values()] };
}

export function storyHandle(config: CliConfig, override: string | undefined, osUser: string): string {
  const handle = override?.replace(/^@/, '') || config.github?.login || osUser;
  return handle || 'me';
}

function osUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

/** Offline: this machine's ledger plus the other machines as of the last publish. */
export async function loadStoryData(options: { range: StoryRange; handle?: string; today?: string }): Promise<StoryData> {
  const [config, ledger, others] = await Promise.all([readConfig(), readLedger(ledgerPath()), readMachinesCache()]);
  const { rows, costRows } = storyRows(combinedUsage(ledger, others));
  return buildStory({
    handle: storyHandle(config, options.handle, osUserName()),
    range: options.range,
    todayUtc: options.today ?? dateKey(new Date()),
    rows,
    costRows,
  });
}
