import { addDays, dateKey, GRAPH_WINDOW_DAYS, renderPublishedGraphs } from '@tokengraph/core';
import type { CliConfig } from '../config.js';
import type { Gist, GitHubClient } from '../github/http.js';
import type { Ledger } from '../ledger.js';
import { ensureDataGist, ensureGraphGist, gistLookup, graphGistReadme } from './gists.js';
import {
  activeDayCount,
  combinedUsage,
  isMachineFileName,
  machineFileName,
  machineLabel,
  maxMergeLedgers,
  parseMachineFile,
  resolveMachineId,
  serializeMachineFile,
  sourcesDigest,
  type MachineFile,
} from './machines.js';

export interface PublishInput {
  client: GitHubClient;
  login: string;
  config: CliConfig;
  /** This machine's ledger after collecting. */
  ledger: Ledger;
  /** Local date key the graph ends on. */
  today: string;
  nowIso: string;
  cliVersion: string;
  platform: NodeJS.Platform;
  fingerprint: string;
  newMachineId: () => string;
}

export interface PublishResult {
  /** The ledger after merging this machine's own gist copy back in (save it). */
  ledger: Ledger;
  /** The config with machine id and gist ids filled in (save it). */
  config: CliConfig;
  graphGistId: string;
  dataGistId: string;
  /** Every other machine's file, for the offline cache. */
  others: MachineFile[];
  adopted: boolean;
  /** Days this machine's ledger gained back from its gist copy. */
  restoredDays: number;
  wroteMachineFile: boolean;
  /** This machine's file exists in the data gist but could not be read: it was left untouched. */
  ownFileUnreadable: boolean;
  updatedGraphFiles: string[];
  graphGistCreated: boolean;
  /** A cached graph gist was gone: the README snippet changed. */
  graphGistReplaced: boolean;
}

function machineFiles(gist: Gist): MachineFile[] {
  return Object.entries(gist.files).flatMap(([name, file]) => {
    if (!file?.content || !isMachineFileName(name)) return [];
    const parsed = parseMachineFile(file.content);
    return parsed && machineFileName(parsed.machineId) === name ? [parsed] : [];
  });
}

export async function publish(input: PublishInput): Promise<PublishResult> {
  const { client } = input;
  const lookup = gistLookup(client);

  // 1. The data gist: who else publishes, and this machine's own backup.
  const data = await ensureDataGist(client, input.config.gists?.data, lookup);
  const files = machineFiles(data.gist);
  const { machineId, adopted } = resolveMachineId({
    configured: input.config.machineId,
    files,
    fingerprint: input.fingerprint,
    newId: input.newMachineId,
  });
  const own = files.find((file) => file.machineId === machineId) ?? null;
  // A file under our name that does not parse may hold more than our ledger: never overwrite it.
  const ownFileUnreadable = own === null && machineFileName(machineId) in data.gist.files;
  const others = files.filter((file) => file.machineId !== machineId);

  // 2. Within one machine totals only grow: take back anything the local ledger lost.
  const ledger = own ? maxMergeLedgers(input.ledger, own.sources) : input.ledger;
  const restoredDays = activeDayCount(ledger.sources) - activeDayCount(input.ledger.sources);

  // 3. Write this machine's file only when its usage changed; never touch another machine's file.
  let wroteMachineFile = false;
  if (!ownFileUnreadable && (!own || sourcesDigest(own.sources) !== sourcesDigest(ledger.sources))) {
    const file: MachineFile = {
      schema: 1,
      machineId,
      label: machineLabel(input.platform, machineId),
      fingerprint: input.fingerprint,
      cliVersion: input.cliVersion,
      updatedAt: input.nowIso,
      sources: ledger.sources,
    };
    await client.updateGist(data.gist.id, { [machineFileName(machineId)]: serializeMachineFile(file) });
    wroteMachineFile = true;
  }

  // 4. The graph: every machine summed, rendered, and only changed files sent.
  const since = dateKey(addDays(new Date(`${input.today}T12:00:00Z`), -GRAPH_WINDOW_DAYS), 'UTC');
  const colors = input.config.graph?.colors ?? 'model';
  const svgs: Record<string, string> = renderPublishedGraphs(combinedUsage(ledger, others, since), { today: input.today, colors });
  const graph = await ensureGraphGist(client, input.config.gists?.graph, lookup, svgs);
  const wanted: Record<string, string> = { ...svgs, 'README.md': graphGistReadme(input.login, graph.gist.id) };
  const changed = Object.fromEntries(Object.entries(wanted).filter(([name, content]) => graph.gist.files[name]?.content !== content));
  if (Object.keys(changed).length > 0) await client.updateGist(graph.gist.id, changed);

  return {
    ledger,
    config: { ...input.config, machineId, gists: { graph: graph.gist.id, data: data.gist.id } },
    graphGistId: graph.gist.id,
    dataGistId: data.gist.id,
    others,
    adopted: adopted !== null,
    restoredDays: Math.max(0, restoredDays),
    wroteMachineFile,
    ownFileUnreadable,
    updatedGraphFiles: Object.keys(changed).sort(),
    graphGistCreated: graph.created,
    graphGistReplaced: graph.replacedCached,
  };
}
