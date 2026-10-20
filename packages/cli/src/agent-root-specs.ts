import { CLINE_ROOTS } from './adapters/cline/roots.js';
import { CLAUDE_CODE_ROOTS } from './adapters/claude-code/roots.js';
import { CODEX_ROOTS } from './adapters/codex/roots.js';
import { COPILOT_ROOTS } from './adapters/copilot-cli/roots.js';
import { GEMINI_ROOTS } from './adapters/gemini-cli/roots.js';
import { GOOSE_ROOTS } from './adapters/goose/roots.js';
import { KILO_FLAVOUR } from './adapters/kilo/flavour.js';
import { familyRootSpec } from './adapters/opencode/family-roots.js';
import { OPENCODE_FLAVOUR } from './adapters/opencode/flavour.js';
import { PI_ROOTS } from './adapters/pi/roots.js';
import { QWEN_ROOTS } from './adapters/qwen-code/roots.js';
import type { RootSpec } from './agent-roots.js';

export const OPENCODE_ROOTS: RootSpec = familyRootSpec(OPENCODE_FLAVOUR);
export const KILO_ROOTS: RootSpec = familyRootSpec(KILO_FLAVOUR);

/** Every adapter that reads files at a location that can move, in the order sync reports them. Cursor reads only tokengraph's own files. */
export const ROOT_SPECS: readonly RootSpec[] = [
  CLAUDE_CODE_ROOTS,
  CODEX_ROOTS,
  GEMINI_ROOTS,
  CLINE_ROOTS,
  OPENCODE_ROOTS,
  KILO_ROOTS,
  COPILOT_ROOTS,
  PI_ROOTS,
  QWEN_ROOTS,
  GOOSE_ROOTS,
];
