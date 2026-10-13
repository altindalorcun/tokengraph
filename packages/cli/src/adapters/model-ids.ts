/** Longest model id kept; longer ids are cut so a damaged record cannot bloat the ledger. */
export const MAX_MODEL_NAME_LENGTH = 120;

const CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const CANONICAL_CLAUDE = /^claude-(opus|sonnet|haiku|fable)-\d+(-\d+)?(-\d{8})?$/;
// Version-first naming (`claude-3-7-sonnet`) is only how Anthropic named Claude 1.x-3.x; a
// major of 4+ in that shape (e.g. `claude-4-sonnet`) is not a real canonical id and must still
// go through the family/version rebuild below so it comes out as `claude-sonnet-4`, the same as
// `claude-4-sonnet-thinking` does — otherwise the same model gets two different stored names
// depending only on whether Cursor appended a thinking/effort suffix.
const LEGACY_CLAUDE = /^claude-[1-3](-\d+)?-(opus|sonnet|haiku)(-\d{8})?$/;

/**
 * Tools name Anthropic models their own way — `claude-4.5-opus-high-thinking`, `claude-opus-4.6` —
 * while Anthropic's API and Claude Code call the same model `claude-opus-4-5`. Normalising to that
 * form makes a model's usage merge with its usage from other tools. Thinking / effort / mode
 * words (`thinking`, `high`, `max`, …) are the same model and are dropped. Claude 3.x keeps Anthropic's
 * older version-first naming (`claude-3-7-sonnet`). Anything not recognisably a Claude model id is
 * returned unchanged rather than guessed.
 */
export function normalizeClaudeModel(raw: string): string {
  const model = raw.trim().toLowerCase();
  if (!model.startsWith('claude-') || CANONICAL_CLAUDE.test(model) || LEGACY_CLAUDE.test(model)) {
    return model.startsWith('claude-') ? model : raw;
  }
  const parts = model.split('-');
  // A part glued to something other than `-` (e.g. a stray `@20251101` suffix) is not a
  // recognised word or version number; guessing around it risks merging two different models
  // under one name, so it is safer to leave the id exactly as given.
  if (parts.some((part) => /[^a-z0-9.]/.test(part))) return model;
  const family = parts.find((part) => CLAUDE_FAMILIES.has(part));
  const version = parts.filter((part) => /^\d{1,2}(\.\d{1,2})?$/.test(part)).flatMap((part) => part.split('.'));
  if (!family || version.length === 0 || version.length > 2) return model;
  const major = Number(version[0]);
  return major < 4 ? `claude-${version.join('-')}-${family}` : `claude-${family}-${version.join('-')}`;
}

/**
 * `model_id` is a tool's own field and not documented to have a length limit, so it is
 * truncated (base first, so a suffix always fits) to stay within what the server accepts —
 * an over-length name would otherwise be dropped from every upload forever.
 */
export function capModelName(base: string, suffix = ''): string {
  const appliedSuffix = suffix && !base.endsWith(suffix) ? suffix : '';
  const maxBaseLength = MAX_MODEL_NAME_LENGTH - appliedSuffix.length;
  return `${base.slice(0, maxBaseLength)}${appliedSuffix}`;
}

/**
 * A model id that looks like a filesystem path or an AWS ARN rather than a real model
 * identifier — starts with `/`, `~`, `arn:`, a Windows drive letter (`C:\` / `C:/`), or contains
 * `/Users/` or `/home/`. Privacy: uploads never carry file paths or account ids (an ARN embeds an
 * AWS account id), so a value shaped like one is treated as leaked/mistaken input and reported as
 * `unknown` rather than uploaded verbatim.
 */
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
function looksLikePathOrArn(model: string): boolean {
  return (
    model.startsWith('/') ||
    model.startsWith('~') ||
    model.startsWith('arn:') ||
    WINDOWS_DRIVE_PREFIX.test(model) ||
    model.includes('/Users/') ||
    model.includes('/home/')
  );
}

/** Vendor prefixes a gateway (OpenRouter, Cline, Vercel AI Gateway, OpenCode Zen) puts before a model id. */
const STRIPPED_VENDOR_PREFIXES = new Set(['anthropic', 'openai', 'google']);
const BEDROCK_PROVIDERS = new Set(['bedrock', 'amazon-bedrock']);
const VERTEX_PROVIDERS = new Set(['vertex', 'google-vertex', 'google-vertex-anthropic']);
const BEDROCK_REGION_PREFIX = /^(us|eu|apac|global|jp)\./;
const BEDROCK_VERSION_SUFFIX = /-v\d+(:\d+)?$/;
const VERTEX_VERSION_SUFFIX = /@[^@]+$/;

/**
 * The id a model's usage is stored under, whichever tool or gateway made the request. Only
 * decorations that are documented for a provider are removed — a gateway's `anthropic/` vendor
 * prefix, Bedrock's region and `anthropic.` prefixes and `-v1:0` suffix, Vertex's `@version`
 * suffix — and then Claude ids go through {@link normalizeClaudeModel}. Anything else (open-weight
 * models, a custom provider's name) is kept exactly as the tool recorded it: guessing a mapping
 * could merge two different models under one name.
 */
export function canonicalModelId(providerId: string | null | undefined, modelId: string | null | undefined): string {
  let model = (modelId ?? '').trim();
  if (model.length === 0) return 'unknown';
  if (looksLikePathOrArn(model)) return 'unknown';
  const provider = (providerId ?? '').trim().toLowerCase();

  if (BEDROCK_PROVIDERS.has(provider)) {
    model = model.replace(BEDROCK_REGION_PREFIX, '').replace(/^anthropic\./, '').replace(BEDROCK_VERSION_SUFFIX, '');
  } else if (VERTEX_PROVIDERS.has(provider)) {
    model = model.replace(VERTEX_VERSION_SUFFIX, '');
  }
  const slash = model.indexOf('/');
  if (slash > 0 && STRIPPED_VENDOR_PREFIXES.has(model.slice(0, slash).toLowerCase())) {
    model = model.slice(slash + 1);
  }
  return capModelName(normalizeClaudeModel(model));
}
