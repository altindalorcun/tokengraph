// Documented differences between the fake server's log and what tokengraph counts. See run.mjs.
//
// A rule rewrites the EXPECTED counters of one (agent, model) group before they are compared, so a PASS means "matches
// our documented semantics". Anything not listed here is a FAIL. Each rule names the docs/agents sentence that
// justifies it.
//
// Rule shape: { id, doc, describe, applies({ agent, protocols, model, entries }), adjust(expected, { entries, raw }) }
// `entries` are the server log lines of that group (each has `normalized` and `reasoning`).
const sum = (entries, key) => entries.reduce((total, e) => total + (e[key] ?? 0), 0);

/** Take the normalized counters of the given log entries out of `expected`. */
function subtract(expected, entries) {
  for (const e of entries) for (const k of Object.keys(expected)) expected[k] -= e.normalized?.[k] ?? 0;
}

export const RULES = [
  {
    id: 'opencode-title-requests',
    doc: 'docs/agents/opencode-usage.md:289, 401-402, 468 (title generation is never written to a message or part, so it has no model/day record)',
    describe: 'OpenCode asks its small model for a session title with no tools offered; that request is not recorded per message',
    applies: ({ agent }) => agent === 'opencode',
    adjust(expected, { entries }) {
      const titles = entries.filter((e) => (e.toolNames ?? []).length === 0);
      subtract(expected, titles);
      return `${titles.length} title request(s) (no tools offered) left out`;
    },
  },
  {
    id: 'cline-reasoning-subtracted',
    doc: 'docs/agents/cline-usage.md:402-412 ("Reasoning warning": the SDK subtracts reasoning from outputTokens and drops reasoningTokenCount when persisting)',
    describe: 'Cline 3.x persists output without the reasoning tokens that OpenAI-style providers report inside completion_tokens, so they cannot be counted',
    applies: ({ agent, protocols }) => agent === 'cline' && protocols.some((p) => p === 'chat' || p === 'responses'),
    adjust(expected, { entries }) {
      const reasoning = sum(entries.filter((e) => e.protocol === 'chat' || e.protocol === 'responses'), 'reasoning');
      expected.output -= reasoning;
      return `output minus ${reasoning} reasoning tokens`;
    },
  },
];
