# Aider local token usage data (research note)

This note examines whether we can read daily token usage from the local files of Aider
(Aider-AI/aider, Python). There is no adapter yet; this document was written to support that
decision. Source examined: the `main` branch, commit
[`5dc9490`](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c)
(22 May 2026, `v0.86.3.dev`), with the pinned dependency `litellm==1.82.3`
([requirements.txt](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/requirements.txt#L184)).
Aider is not installed on the machine this was written on; everything below is based on reading
the source code and was not verified against a real Aider run.

**Verdict: not ready.** With default settings Aider writes no machine-readable local record that
carries the token count, the model and a timestamp for each request together. Even the one
structured record the user has to switch on (`--analytics-log`) holds Aider's own local tokenizer
estimate instead of the provider's real counts in the default streaming mode, and, with streaming
off, a single "sent" number with no split between cache reads and cache writes.

## Local data locations

| File | Default | Location | Token count? | Model? | Time? |
| --- | --- | --- | --- | --- | --- |
| `.aider.chat.history.md` | **on** | root of each git repository (cwd if there is no repo) | a `> Tokens: …` line, as rounded text | only in the session-start announcement | only at session start |
| `.aider.input.history` | on | root of each git repository (cwd if there is no repo) | none | none | prompt_toolkit input time |
| `--llm-history-file` | **off** (`None`) | chosen by the user | none | none | one-second resolution for each request/response |
| `--analytics-log` | **off** | chosen by the user | in the `message_send` event | yes (sometimes redacted) | epoch seconds |
| `~/.aider/analytics.json` | on | home | none (only the uuid and opt-in state) | — | — |

The default paths are computed relative to the git root in `args.py`:
[args.py#L271-L300](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/args.py#L271-L300).
So the chat history is scattered across **each project's own directory**; there is no central
directory such as `~/.aider/sessions`.

### `.aider.chat.history.md`

Every write goes through `InputOutput.append_chat_history()` and is appended to the file with
`open("a")`
([io.py#L1117-L1136](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L1117-L1136)).
Format:

```markdown

# aider chat started at 2026-09-27 14:03:11

> Main model: claude-sonnet-4-5 with diff edit format, prompt cache, infinite output
> Weak model: claude-haiku-4-5
> ...

#### the user's message

the model's reply (markdown)

> Tokens: 12k sent, 3.1k cache write, 45k cache hit, 812 received. Cost: $0.05 message, $0.12 session.
```

- **The timestamp appears only at the start of a session**: `# aider chat started at %Y-%m-%d %H:%M:%S`
  (local time, no time zone)
  ([io.py#L335-L336](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L335-L336)).
  There is no time per message, so the messages of a session that crosses midnight cannot be
  assigned to the right day.
- **The `Tokens:` line is written to the file.** `show_usage_report()` prints the report with
  `io.tool_output()`
  ([base_coder.py#L2102-L2128](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L2102-L2128)),
  and `tool_output()` first appends every message to the md file with a `> ` prefix through
  `append_chat_history(..., blockquote=True)`, then prints it to the terminal
  ([io.py#L995-L1012](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L995-L1012)).
- **The numbers are rounded.** `format_tokens()`: a whole number below `1000`, `3.1k` below
  `10000`, and above that `round(n/1000)` as in `45k`
  ([utils.py#L279-L285](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/utils.py#L279-L285)).
  So every number above 10,000 is off by up to ±500; the exact integer cannot be recovered from
  this data.
- **The model name is not on the message line**; it appears only in the session-start
  announcement (`Model:` or `Main model: <name> with <format> edit format`,
  [base_coder.py get_announcements](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L207-L240))
  and in the output of commands such as `/model`. In architect mode the editor model is a
  separate coder; which `Tokens:` line belongs to which model cannot be reliably worked out from
  the text.
- **The format changed between versions.** Older versions wrote `Tokens: 26,200 sent, 680 received.
  Cost: $0.09 request, $0.12 session.` (whole numbers, with commas, `request`)
  ([tests/fixtures/chat-history-search-replace-gold.txt#L770](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/tests/fixtures/chat-history-search-replace-gold.txt#L770)).
  Both formats can appear in the same file.
- The file is free text owned by the user: users delete it, add it to `.gitignore`, commit it and
  edit it by hand. A line starting with `> Tokens:` inside a model reply (for example, a session
  that reads this very note) produces a false match.

### `.aider.input.history`

The prompt_toolkit `FileHistory` format (`# <date>` + `+line`); only what the user typed
([io.py#L737-L752](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L737-L752)).
It holds no token or model information and is not a usage source.

### `--llm-history-file`

Defaults to `None`
([args.py#L295-L300](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/args.py#L295-L300)).
When set, every `send()` call writes `TO LLM <iso-time>` followed by the complete messages, and
`LLM RESPONSE <iso-time>` followed by the reply text
([io.py#L754-L766](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L754-L766),
[base_coder.py#L1793](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1793)).
It has no token counts and no model name, and it carries all the prompt and code content. It
should not be read, for privacy reasons.

### `--analytics-log` (the one structured source, opt-in)

If a `logfile` is given, `Analytics.event()` appends every event as JSONL even when PostHog
analytics is off (`if not self.mp and not self.ph and not self.logfile: return`)
([analytics.py#L213-L253](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/analytics.py#L213-L253)).
The docs recommend it explicitly: `aider --analytics-log filename.jsonl --no-analytics`
([analytics.md](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/website/docs/more/analytics.md)).
The file is still written when analytics was disabled permanently with `--analytics-disable`
([main.py#L636-L664](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py#L636-L664)).
`~/.aider/analytics.jsonl` is **not** a default; only the Aider author's own script uses that
path
([scripts/my_models.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/scripts/my_models.py#L8-L28)).
`~/.aider/analytics.json` (no trailing `l`) holds only `uuid`, `permanently_disable` and
`asked_opt_in`
([analytics.py#L137-L193](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/analytics.py#L137-L193)).

Record format (from the official sample file,
[sample-analytics.jsonl](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/website/assets/sample-analytics.jsonl)):

```json
{"event": "message_send",
 "properties": {"main_model": "gemini/gemini-2.5-pro", "weak_model": "gemini/gemini-2.5-flash-lite",
                "editor_model": "gemini/gemini-2.5-pro", "edit_format": "ask",
                "prompt_tokens": 10006, "completion_tokens": 81, "total_tokens": 10087,
                "cost": 0.0133175, "total_cost": 0.0133175},
 "user_id": "c42c4e6b-f054-44d7-ae1f-6726cc41da88", "time": 1755100406}
```

- `time`: `int(time.time())`, UTC epoch seconds; it can be turned into a local day with `dateKey`.
- `main_model`: the coder's model (in architect mode the editor coder's `main_model` is the
  editor model, [architect_coder.py#L22-L37](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/architect_coder.py#L22-L37)).
  `_redact_model_name()` turns models that are not in litellm's model database into
  `provider/REDACTED`, and returns `None` when there is no `/`; because non-numeric values are
  passed through `str()`, the field then becomes the **string `"None"`**
  ([analytics.py#L195-L233](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/analytics.py#L195-L233)).
- There is **no** cache read/write field; only `prompt_tokens`, `completion_tokens` and
  `total_tokens`.
- There is no unique id per event (`user_id` is constant per installation).

What the user has to do (the path goes straight to `open()` without `expanduser`, so an
**absolute path** is required):

```bash
# environment variable (configargparse, AIDER_ prefix)
export AIDER_ANALYTICS_LOG="$HOME/.aider/analytics.jsonl"
# or in ~/.aider.conf.yml
analytics-log: /Users/<user>/.aider/analytics.jsonl
# and, for correct numbers (see below)
stream: false
```

([main.py#L464-L496](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py#L464-L496),
[args.py#L35-L41](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/args.py#L35-L41),
[args.py#L569-L594](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/args.py#L569-L594))

## How the numbers are computed (`base_coder.py`)

The flow: `send_message()` → (retries / `FinishReasonLength` continuations) `send()` →
`calculate_and_show_tokens_and_cost()` on every successful reply → `show_usage_report()` once
when the loop ends
([base_coder.py#L1419-L1532](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1419-L1532),
[#L1783-L1833](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1783-L1833)).
`message_tokens_sent/received` accumulate; `show_usage_report()` writes them to the md line and
the `message_send` event and resets them. So a record is **per user message**, not per API
request (when output hits the length limit and continues, several requests are folded into one
record).

`calculate_and_show_tokens_and_cost()`
([#L1994-L2068](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1994-L2068)):

```python
if completion and hasattr(completion, "usage") and completion.usage is not None:
    prompt_tokens = completion.usage.prompt_tokens
    completion_tokens = completion.usage.completion_tokens
    cache_hit_tokens = getattr(usage, "prompt_cache_hit_tokens", 0) or getattr(usage, "cache_read_input_tokens", 0)
    cache_write_tokens = getattr(usage, "cache_creation_input_tokens", 0)
    if hasattr(usage, "cache_read_input_tokens") or hasattr(usage, "cache_creation_input_tokens"):
        self.message_tokens_sent += prompt_tokens
        self.message_tokens_sent += cache_write_tokens
    else:
        self.message_tokens_sent += prompt_tokens
else:
    prompt_tokens = self.main_model.token_count(messages)
    completion_tokens = self.main_model.token_count(self.partial_response_content)
    self.message_tokens_sent += prompt_tokens
```

### 1. Streaming (the default, `--stream` defaults to `True`): the numbers are estimates

[args.py#L323-L327](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/args.py#L323-L327).
When streaming, `completion` is a litellm `CustomStreamWrapper`; the class itself has no `usage`
attribute
([litellm v1.82.3 streaming_handler.py](https://github.com/BerriAI/litellm/blob/v1.82.3/litellm/litellm_core_utils/streaming_handler.py#L82-L160)).
Aider does not send `stream_options={"include_usage": True}` either (it never appears in the
repository), and `show_send_output_stream()` skips chunks with empty `choices` (the usage chunk)
([base_coder.py#L1900-L1906](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1900-L1906)).
The result: the `else` branch runs, so `prompt_tokens` is the `litellm.token_counter()` estimate
of the messages sent (cached part included, no split), and `completion_tokens` is the local
tokenizer's estimate of the reply text
([models.py#L650-L670](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/models.py#L650-L670)).
Aider's own documentation says so too: "caching statistics and costs are not available when
streaming responses. To turn off streaming, use `--no-stream`"
([caching.md](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/website/docs/usage/caching.md)).
In default use both the md line and the analytics record are **estimates**, which conflicts with
tokengraph's rule that nothing is guessed.

### 2. `--no-stream`: real numbers, but the split is lost

In litellm 1.82.3, for Anthropic `prompt_tokens = input_tokens + cache_creation_input_tokens
+ cache_read_input_tokens`
([litellm anthropic/chat/transformation.py `calculate_usage`](https://github.com/BerriAI/litellm/blob/v1.82.3/litellm/llms/anthropic/chat/transformation.py#L1573-L1680)).
Aider's comment, though, assumes the old semantics ("cache_creation_input_tokens +
cache_read_input_tokens + prompt == total") and adds the cache write once more
([base_coder.py#L2082-L2089](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L2082-L2089)).
According to this reading of the source, for Anthropic `message_tokens_sent = input + 2 × cache_write +
cache_read` (see "Not verified"). `message_send.prompt_tokens` is this value; `cache_hit` and
`cache_write` are never written to the analytics event and exist only as rounded text in the md
line. For OpenAI, litellm's `prompt_tokens` includes the cached tokens; the split is again not
recorded.

### 3. Calls that are never counted

These LLM calls enter neither the md `Tokens:` line nor the `message_send` event:

- commit message generation (weak model, `simple_send_with_retries`,
  [repo.py#L361](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py#L361)),
- chat summarisation (weak model,
  [history.py#L116](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/history.py#L116)),
- the cache warm-up requests of `--cache-keepalive-pings`
  ([base_coder.py#L1360-L1392](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1360-L1392)),
- failed or retried requests (counted only on `ContextWindowExceededError`).

## Mapping to tokengraph fields

The best mapping possible if the source were `--analytics-log`:

| Aider field | tokengraph field | Problem |
| --- | --- | --- |
| `prompt_tokens` | `inputTokens` | includes cache read/write; an estimate when streaming; cache write counted twice on Anthropic |
| `completion_tokens` | `outputTokens` | an estimate when streaming |
| — | `cacheCreationTokens` | not recorded |
| — | `cacheReadTokens` | not recorded |
| — | `cacheCreation5mTokens` / `1hTokens` | `null` |
| `properties.main_model` | model | may be `"None"` / `…/REDACTED` |
| `time` | day | epoch seconds, no problem |
| — | `pricingTier` | no long-context/fast information |

Cache reads would enter `inputTokens` with a weight of `1` instead of `0.1`; in a cache-heavy
Claude session the weighted total would be inflated several times over. Combined with the rules
"totals only ever grow" and "the graph and the terminal view match exactly", that would be an
error that cannot be undone.

## Dedup and risks

- **Analytics log**: append-only JSONL, one file. There is no event id; a hash of the whole line
  could be used for dedup (`total_cost` is cumulative, so collisions are unlikely, but for a model
  with an unknown price `cost`/`total_cost` stays 0 and identical numbers could repeat within the
  same second). Several Aider processes can append to the same file; the lines are short but
  there is no lock.
- **Chat md**: a separate file in every repository, so the file system would have to be scanned
  (slow, permission prompts, a privacy surface such as `~/Library`; prompt and code content would
  get read). There is no message time, the numbers are rounded, the model context is inferred
  from text, the format depends on the version, and the user can edit or delete the file;
  `--restore-chat-history` does not rewrite old content, but the user can copy or move the file.
  There is no dedup key. It is **not suitable** as a usage source.
- **Other tools**: the popular trackers we looked at do not support Aider. The word `aider` does
  not appear in the repositories of [tokscale](https://github.com/junhoyeo/tokscale/tree/1d9a9395418efc6952944b794097935d7d6fa1e8)
  (`1d9a939`, 25 September 2026) or [ccusage](https://github.com/ryoppippi/ccusage) (`main`). The only known parser is Aider's
  own `scripts/my_models.py`: it sums `total_tokens` of the `message_send` events in
  `~/.aider/analytics.jsonl` per model, so it does not split cache either.

## Recommendation

1. An Aider adapter should not be written for now.
2. If one is opened, the only reasonable path is opt-in: read the `message_send` events with
   `AIDER_ANALYTICS_LOG=<absolute path>` + `AIDER_STREAM=false`, and mark the source
   "approximate / no cache split". Even that forces `--no-stream` (which degrades the user's
   experience), and without a cache split the weighted total cannot be compared with Claude Code
   data.
3. The proper fix is an upstream contribution to Aider: have the `message_send` event (or a
   separate local JSONL) record the raw per-request `usage` fields (`cache_read_input_tokens`,
   `cache_creation_input_tokens`, model, time, request id) and use `stream_options.include_usage`
   when streaming. An alternative is for the user to run Aider through a litellm proxy (out of
   scope).

## Not verified

- Aider was not run; no real `.aider.chat.history.md` or analytics log was examined. All formats
  come from the source code and the sample files in the repository.
- The conclusion that cache writes are counted twice on Anthropic rests on litellm 1.82.3's
  `calculate_usage` code and on the assumption that `hasattr(usage, "cache_creation_input_tokens")`
  returns `True`. litellm's `Usage` also keeps these fields as `PrivateAttr`
  ([types/utils.py `class Usage`](https://github.com/BerriAI/litellm/blob/v1.82.3/litellm/types/utils.py#L1472));
  the `hasattr` result, and the litellm version a user has installed (unpinned installs), were
  not tested with a real request.
- That `hasattr(completion, "usage")` is `False` on a `CustomStreamWrapper` when streaming was
  inferred from the class body having no `usage` definition; whether an indirect route such as
  `__getattr__` exists was not verified at run time. Aider's own documentation supports the
  conclusion.
- litellm's `prompt_tokens` semantics for OpenAI / Gemini / DeepSeek, and which `hasattr`
  branches each model falls into, were not examined model by model.
- The first version that introduced the rounded md format (the switch from comma-separated whole
  numbers to the `k` format) was not determined.
- Trackers other than tokscale and ccusage (for example smaller or newer projects) were not
  scanned; a web search found no other tool that parses Aider.

## Sources

- [aider/coders/base_coder.py @5dc9490](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py): `send`, `calculate_and_show_tokens_and_cost`, `compute_costs_from_tokens`, `show_usage_report`.
- [aider/io.py @5dc9490](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py): `append_chat_history`, `tool_output`, `log_llm_history`, the session header.
- [aider/analytics.py @5dc9490](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/analytics.py): `event`, the log record format, model name redaction.
- [aider/args.py @5dc9490](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/args.py): file defaults, `--stream`, `--analytics-log`.
- [aider/main.py @5dc9490](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py): config file search order, analytics setup.
- [Aider analytics documentation](https://aider.chat/docs/more/analytics.html) and [sample-analytics.jsonl](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/website/assets/sample-analytics.jsonl).
- [Aider prompt caching documentation](https://aider.chat/docs/usage/caching.html): no cache statistics when streaming.
- [Aider options reference](https://aider.chat/docs/config/options.html).
- [litellm v1.82.3 Anthropic transformation](https://github.com/BerriAI/litellm/blob/v1.82.3/litellm/llms/anthropic/chat/transformation.py) and [streaming_handler.py](https://github.com/BerriAI/litellm/blob/v1.82.3/litellm/litellm_core_utils/streaming_handler.py).
- [tokscale @1d9a939](https://github.com/junhoyeo/tokscale/tree/1d9a9395418efc6952944b794097935d7d6fa1e8), [ccusage](https://github.com/ryoppippi/ccusage): no Aider support.
- [Aider issue #2491: Enormous token counts and costs](https://github.com/Aider-AI/aider/issues/2491): a user report on counting anomalies (for context).
