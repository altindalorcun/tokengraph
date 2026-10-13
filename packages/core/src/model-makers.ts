import { AGENT_LOGOS, type BrandLogoArt } from './agent-logos.js';
import { MAKER_LOGOS } from './maker-logos.js';

export type Maker =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'qwen'
  | 'meta'
  | 'mistral'
  | 'xai'
  | 'moonshot'
  | 'zhipu'
  | 'minimax'
  | 'cohere';

const NAMES: Record<Maker, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  meta: 'Meta',
  mistral: 'Mistral AI',
  xai: 'xAI',
  moonshot: 'Moonshot AI',
  zhipu: 'Zhipu AI',
  minimax: 'MiniMax',
  cohere: 'Cohere',
};

/** A name fragment counts only at the start of the id or after a separator ("opus-mt" is not "gpt"). */
const at = (alternatives: string) => new RegExp(`(?:^|[^a-z0-9])(?:${alternatives})`);

/**
 * In priority order: a distilled model that names two makers ("deepseek-r1-distill-llama-70b")
 * belongs to whoever trained it, which is the first name in the id.
 */
const RULES: readonly (readonly [Maker, RegExp])[] = [
  ['anthropic', at('claude|anthropic')],
  ['deepseek', at('deepseek')],
  ['qwen', at('qwen|qwq')],
  ['openai', at('gpt|chatgpt|codex|o[134](?![a-z0-9.])|openai')],
  ['google', at('gemini|gemma')],
  ['meta', at('llama')],
  ['mistral', at('mistral|mixtral|codestral|devstral|magistral')],
  ['xai', at('grok')],
  ['moonshot', at('kimi|moonshot')],
  ['zhipu', at('glm|zhipu')],
  ['minimax', at('minimax|abab')],
  ['cohere', at('command|cohere')],
];

function match(id: string): Maker | null {
  for (const [maker, pattern] of RULES) if (pattern.test(id)) return maker;
  return null;
}

/**
 * The company behind a model, from the id as a tool recorded it. Provider prefixes
 * ("anthropic/", "openrouter/qwen/", Bedrock's "us.anthropic.") don't hide it; the last path
 * segment is tried first so a router name can't outrank the model itself. Unknown ids give null.
 */
export function modelMaker(modelId: string): Maker | null {
  const id = modelId.toLowerCase().trim();
  const last = id.slice(id.lastIndexOf('/') + 1);
  return match(last) ?? (last === id ? null : match(id));
}

export function makerName(maker: Maker): string {
  return NAMES[maker];
}

/** The first recognisable maker among ids that are all the same model (dated snapshots share one). */
export function makerOfIds(ids: readonly string[]): Maker | null {
  for (const id of ids) {
    const maker = modelMaker(id);
    if (maker) return maker;
  }
  return null;
}

/**
 * What the graph colours by in per-model mode: the family a model belongs to. Claude, GPT,
 * Gemini, DeepSeek, Qwen, GLM and Kimi each have a hue; everything else, including ids nobody
 * recognises, shares "other". The order is the legend's and breaks ties.
 */
export type ModelFamily = 'claude' | 'gpt' | 'gemini' | 'deepseek' | 'qwen' | 'glm' | 'kimi' | 'other';

export const MODEL_FAMILIES: readonly ModelFamily[] = ['claude', 'gpt', 'gemini', 'deepseek', 'qwen', 'glm', 'kimi', 'other'];

export const FAMILY_LABELS: Record<ModelFamily, string> = {
  claude: 'Claude',
  gpt: 'GPT',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  glm: 'GLM',
  kimi: 'Kimi',
  other: 'Other models',
};

const MAKER_FAMILIES: Partial<Record<Maker, ModelFamily>> = {
  anthropic: 'claude',
  openai: 'gpt',
  google: 'gemini',
  deepseek: 'deepseek',
  qwen: 'qwen',
  zhipu: 'glm',
  moonshot: 'kimi',
};

export function familyForMaker(maker: Maker | null): ModelFamily {
  return (maker && MAKER_FAMILIES[maker]) ?? 'other';
}

/** The family of a model id as a tool recorded it; unknown ids are "other", never guessed. */
export function modelFamily(modelId: string): ModelFamily {
  return familyForMaker(modelMaker(modelId));
}

/** Each family's mark for legends. Claude, GPT and Gemini reuse the agents' art so they look identical. */
export const FAMILY_LOGOS: Partial<Record<ModelFamily, BrandLogoArt>> = {
  claude: AGENT_LOGOS['claude-code'],
  gpt: AGENT_LOGOS['codex-cli'],
  gemini: AGENT_LOGOS['gemini-cli'],
  deepseek: MAKER_LOGOS.deepseek,
  qwen: MAKER_LOGOS.qwen,
  glm: MAKER_LOGOS.zhipu,
  kimi: MAKER_LOGOS.moonshot,
};
