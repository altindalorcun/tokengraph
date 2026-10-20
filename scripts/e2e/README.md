# fake-llm

Dev-only fake LLM server for end-to-end agent checks. Point a real agent at it with a custom
base URL, run a session, then compare the tokens tokengraph counted with what the server
reported in its JSONL log. Not shipped in the npm package.

```bash
node scripts/e2e/fake-llm.mjs --port 0 --log /tmp/fake.jsonl --tool-turns 2
# prints: READY <port>
```

Protocols (streaming and non-streaming): Anthropic Messages (`/v1/messages`, `count_tokens`),
OpenAI Chat Completions, OpenAI Responses, Gemini `generateContent` / `streamGenerateContent`,
plus model lists. Any base-URL prefix is accepted. No auth is required. Unknown paths return a
logged 404.

| Flag | Meaning |
|---|---|
| `--port N` | Port on 127.0.0.1; `0` picks a random one (default) |
| `--log FILE` | JSONL log, truncated at start |
| `--models a,b,c` | Names returned by the model-list endpoints |
| `--tool-turns N` | First N turns of a conversation call a read-only tool (name matches `read\|list\|ls\|glob\|view`) when the request offers one |
| `--always-usage` | Send usage in chat streams even without `stream_options.include_usage` |
| `--exit-on-stdin-close` | Exit when stdin closes (handy when spawned by a script) |

## Usage numbers

Response number `n` (1, 2, ...) reports fresh input `1000+7n`, output `50+3n`, cache read
`200+11n`, and for Anthropic cache write `30+5n`, so no two responses share numbers. Reasoning
tokens are `5+n` (OpenAI and Gemini). Per protocol semantics: OpenAI `prompt_tokens` /
`input_tokens` include cached tokens and `completion_tokens` include reasoning; Anthropic
`input_tokens` excludes cache; Gemini `promptTokenCount` includes `cachedContentTokenCount`
and `candidatesTokenCount` excludes thoughts.

## Log lines

One line per request: `{ ts, status, protocol, endpoint, model, responseId, stream, usage,
normalized: { input, output, cacheRead, cacheWrite }, ... }`. `usage` is the object sent (for
Anthropic streams, `message_start` usage with the final `output_tokens`), or `null` when none
was sent (404s, model lists, `count_tokens`, chat streams without `include_usage`).
`normalized` is the exclusive view: `input` is fresh input only and `output` includes
reasoning. Gemini streams repeat identical cumulative `usageMetadata` on every chunk.

Tests: `npx vitest run scripts/e2e`.
