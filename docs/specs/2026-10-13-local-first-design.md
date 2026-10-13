# tokengraph, local-first: design

Date: 2026-10-13. Status: approved by the owner in conversation (folder layout, secret data gist,
own OAuth App with `gh` fallback, QR phone hand-off in the first release).

## Why

The hosted version (Next.js + Supabase + GitHub sign-in + leaderboard, archived at the
`hosted-final` tag of `token-graph` and `tokengraph-cli`) costs money that grows with every user,
and the owner does not want to charge for the product. The goal is now GitHub stars and a tool
people love, promoted on X and Instagram. So tokengraph becomes **local-first and free to run**:
there is no server. Everything happens on the user's machine, and the only thing that leaves it is
what the user chooses to publish to **their own** GitHub gists.

Success: a developer runs `npx tokengraph`, sees their graph in the terminal within seconds, runs
`tokengraph login`, and has the graph in their profile README a minute later, with a snippet
already on their clipboard. `tokengraph story` turns their numbers into an Instagram story they
scan onto their phone with a QR code. The owner pays nothing at any number of users.

## Layout

```
~/codes/tokengraph/                 workspace folder, not a repo
├── cli/              → github.com/altindalorcun/tokengraph        public, MIT, npm `tokengraph`
│   ├── packages/core   pure calculation + SVG rendering, zero runtime dependencies
│   ├── packages/cli    adapters, ledger, terminal view, GitHub publishing, story cards, QR share
│   ├── scripts/        samples generator, font builders
│   └── docs/           product, specs, plans
└── tokengraph-site/  → github.com/altindalorcun/tokengraph-site   private, static promo site
```

- `cli/` starts from the `hosted-final` tree of `tokengraph-cli` (the already leak-scanned public
  mirror) with a fresh history: one import commit, no hosted-era history.
- The core package is renamed `@token-graph/core` → `@tokengraph/core`. It stays `private` and is
  inlined into the CLI bundle; it can be published on its own later without moving any code.
- **Boundary rule:** `packages/core` has no third-party runtime dependency and does no file or
  network I/O. Anything needing Satori, resvg, sockets or the file system lives in `packages/cli`.
- **The site never imports code from `cli/`.** It shows files the CLI generates (see *Samples
  contract*). The `tokengraph-cli` mirror and `scripts/sync-to-public.sh` are retired.

## User-facing CLI

```
tokengraph                 view (in a terminal), unchanged
tokengraph login           connect GitHub (device flow, or reuse `gh`), then first publish
tokengraph logout          forget the GitHub token on this machine (gists stay)
tokengraph sync            read local logs → ledger → publish if logged in
tokengraph readme          print the README snippet and copy it to the clipboard
tokengraph story           render story cards, preview them, send them to the phone by QR
tokengraph status          GitHub account, gists, machines, last publish, hooks/schedule health
tokengraph install-hook    unchanged
tokengraph schedule        unchanged
```

Removed: `uploads [on|off]` (logging out is the off switch), the server device pairing, `api.ts`,
`payload.ts`, `upload-mode.ts`, `upload-record.ts`, `X-Token-Graph-Trigger`, `DEFAULT_API_URL`,
`--api-url`, `--new-device`. Hidden `hook-sync` and `cursor-hook` are unchanged. `sync --trigger`
stays (logs and throttling only).

### `login`

1. If `gh` is on PATH and `gh auth token` returns a token whose `X-OAuth-Scopes` include `gist`,
   offer it in a TTY: `Use your GitHub CLI account @octocat? [Y/n]`. Flags: `--gh` forces it,
   `--device` skips it. Non-TTY defaults to device flow.
2. Device flow against `https://github.com/login/device/code` with client id
   `Ov23liunAdVeHoVD4vgm` (OAuth App "tokengraph", device flow enabled, no client secret exists),
   scope `gist`. Print the code big and clear, copy it to the clipboard, open the verification URL
   (`--no-open` skips). Poll `https://github.com/login/oauth/access_token` honouring `interval`,
   `slow_down` (+5 s), `authorization_pending`, `expired_token`, `access_denied`.
3. `GET /user` to learn the login. Store in `config.json` (mode 0600): `github: { login, auth:
   { kind: 'token', token } | { kind: 'gh', ghPath } }`. For `gh`, the absolute path of `gh` is
   stored and `gh auth token` is called at use time, so our file never holds a copy of a token that
   has `repo` scope, and launchd/cron (minimal PATH) can still find it.
4. Resolve the machine id (see *Machines*), find or create both gists, run a full sync + publish,
   print the README snippet and copy it, then offer `Keep it updated every hour? [Y/n]` (installs
   `schedule`) in a TTY.

### `sync`

Unchanged collection (`collectLocal`, ledger max-merge, sync lock). Then, unless `--local` or not
logged in: publish (below). Output ends with the graph URL. Exit codes: 0 on success or
nothing-to-do; 1 if publishing failed (manual); background triggers log the error to the existing
log files and also exit 1 (the scheduler ignores it).

### `readme`

Prints the snippet and copies it. `--compact` uses the compact files. The snippet links to the
project repo (the star funnel) and switches theme with `<picture>`:

```html
<a href="https://github.com/altindalorcun/tokengraph">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://gist.githubusercontent.com/LOGIN/GIST/raw/tokengraph-dark.svg">
    <img alt="My AI coding token usage, by tokengraph" src="https://gist.githubusercontent.com/LOGIN/GIST/raw/tokengraph-light.svg">
  </picture>
</a>
```

A raw gist URL without a revision serves the latest file as `image/svg+xml`, `max-age=300`,
`Access-Control-Allow-Origin: *` (verified 2026-10-13), so GitHub's image proxy shows updates
within minutes.

## Publishing to GitHub gists

Two gists per GitHub account, found by marker file name (never by id alone, so a second machine
finds them):

| Gist | Visibility | Marker | Files |
|---|---|---|---|
| graph | public | `tokengraph-dark.svg` | `README.md`, `tokengraph-dark.svg`, `tokengraph-light.svg`, `tokengraph-compact-dark.svg`, `tokengraph-compact-light.svg` |
| data | secret | `tokengraph-data.md` | `tokengraph-data.md`, `machine-<machineId>.json` per machine |

- Graph gist description: `My AI coding token graph · made with tokengraph (npx tokengraph)`.
  Its `README.md` shows the graph and links to the project. Every user's gist list advertises the
  project.
- Data gist description: `tokengraph data, written by the tokengraph CLI. Do not edit.` Its
  markdown file explains what it is and that it is unlisted, not private.
- Discovery: page through `GET /gists?per_page=100` for the marker files; cache the ids in
  `config.json`. A cached id that returns 404 (user deleted the gist) is forgotten and the gist is
  recreated; for the graph gist this prints a loud notice that the README snippet changed.
- Writes are `PATCH /gists/:id` with only the changed files, found by comparing with the gist's
  current content (one `GET` per gist per publish, which also notices files someone edited or
  deleted by hand); nothing is sent when nothing changed. SVG rendering is deterministic (no
  timestamps), so the graph changes at most when data changes or the day rolls.
- The other machines' files from the last publish are cached in `~/.tokengraph/machines.json`, so
  `story` (and anything else offline) can show the all-machines numbers without the network.
- API base overridable by `TOKENGRAPH_GITHUB_API` / `TOKENGRAPH_GITHUB_WEB` (tests use a fake
  server). Requests send `User-Agent: tokengraph/<version>`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`. 401 → "Your GitHub access was revoked. Run `tokengraph
  login`." 403/429 with rate-limit headers → skip this run, say when to retry. Network errors never
  touch the local ledger.
- A file returned with `truncated: true` is re-read from its `raw_url`.

### Machines (multi-machine merge and backup)

- `machineId`: a UUID in `config.json`. An existing hosted-era `deviceId` is reused as the
  machine id.
- `machine-<id>.json`:
  `{ schema: 1, machineId, label, fingerprint, cliVersion, updatedAt, sources: LedgerDays-by-source }`,
  the v3 ledger body as is. `label` is `<platform>-<first 6 of id>` (no hostname, which can carry a
  person's name). `fingerprint` is `sha256("tokengraph:" + OS machine id + ":" + os username)`, never the raw
  values. The OS machine id is the stable one (macOS `IOPlatformUUID`, Linux `/etc/machine-id`,
  Windows `MachineGuid`), falling back to the hostname; hostnames alone change with the network
  on macOS.
- Each publish: read the data gist; `local = maxMerge(local, ownRemote)` (restores history this
  machine lost, never shrinks anything); write the ledger; write own file if changed.
- Graph data = this machine's ledger **plus** every other machine's file, summed per day, model and
  tier (different machines are different usage; max-merge applies only within one machine).
- Machine without an id but with a matching `fingerprint` in the gist adopts that id (reinstall,
  wiped `~/.tokengraph`), so the same logs are never counted twice under two ids. It prints
  `Restored this machine's history (N days) from your data gist.`
- `status` lists machines with label and last update; `logout --forget-machine` is not in v1.

### Graph rendering

`toGraphDaysByFamily` (from the web app) and the embed font (`embed-font.ts`, generated, OFL
notice) move into core. The graph covers 372 days ending at `graphEndDate(today, dates)`. Colour
mode defaults to per-family; `config.graph.colors: 'single'` switches it (`tokengraph readme
--colors single|model` sets it and republishes). Full and compact variants, dark and light themes.
A user with no usage yet gets the existing "No tokens synced yet" title, never a broken image.

## Story cards in the CLI

### Rendering

- Pure data (`buildStory` and its helpers from `apps/web/lib/story/data.ts`, `format.ts`,
  `color.ts`, `skyline.ts`, `art.ts`, the needed parts of `lib/dashboard/{aggregate,cost,range,
  stats}`, `lib/model-makers.ts`, `lib/logo.ts`, `lib/demo-usage.ts`) moves to
  `packages/core/src/story/`: it is pure and dependency-free.
- Cards (`cards/*.tsx`, `parts.tsx`) and the Satori + `@resvg/resvg-wasm` pipeline (`png.tsx`) move
  to `packages/cli/src/story/`. JSX compiles with the automatic runtime; `react` is a bundled dev
  dependency (only `jsx-runtime` ends up in the bundle). `satori`, `@resvg/resvg-wasm`, `react` are
  bundled, not runtime dependencies.
- Assets (`resvg.wasm`, seven IBM Plex TTFs, OFL licence) ship in `packages/cli/assets/`, found
  relative to the running script (`../assets` from both `bundle/` and `dist/`). Package grows from
  ~0.33 MB to ~3.5 MB; acceptable.
- Card input rows come from the same merged data as the graph (all machines). The card's `host`
  line becomes `npx tokengraph` (the call to action). Handle: GitHub login, else `--handle`, else the
  OS user name.

### Command

```
tokengraph story [--template skyline|receipt|sticker|all] [--range today|7d|30d|1y]
                 [--no-cost] [--out <dir>] [--no-qr] [--no-preview] [--handle <name>]
```

Defaults: all three templates, `today`, cost shown, `--out` = `~/Downloads` (or the home folder
if there is none), file names from `storyFileName`. Flow in a TTY:

1. Render with a progress line (`Rendering skyline… receipt… sticker…`).
2. **Preview in the terminal.** iTerm2 / WezTerm (OSC 1337 inline image), Kitty / Ghostty (Kitty
   graphics protocol): a real side-by-side thumbnail strip of the three cards, composed with Satori
   and rendered small. Any other terminal: a half-block (`▀`) thumbnail in truecolor, or 256 colours
   when `COLORTERM` does not announce truecolor, drawn from resvg's RGBA pixels. `--no-preview` or
   non-TTY skips it.
3. Print the saved paths (and on macOS offer `o` to reveal them in Finder).
4. Ask `Send them to your phone? [Y/n]` (skipped with `--no-qr`; `--qr` answers yes without
   asking). Then the QR hand-off.

### QR hand-off

- Pick a LAN IPv4: non-internal, private range (10/8, 172.16/12, 192.168/16), preferring Wi-Fi /
  Ethernet interface names. None → explain and stop (cards are still saved).
- `node:http` server bound to that address only, random port. Every URL lives under a 128-bit
  random path token (`/<token>/`); anything else is a bare 404. GET/HEAD only. Serves one page and
  the rendered PNGs from memory, nothing from disk.
- The phone page: a single self-contained HTML document (inline CSS, no external requests), dark
  brand look, the cards full width with a **Save** button each (`download` attribute) and a hint
  per platform: iPhone "touch and hold the image → Save to Photos", Android "touch and hold →
  Download image". `navigator.share` with files is used when the browser offers it (it does not on
  plain http, so it is a progressive extra).
- The terminal shows the QR code (ECC M, quiet zone 4, forced black on white so it scans on dark
  themes) drawn with half blocks, the URL under it, and live events: `📱 Phone connected`,
  `✓ skyline saved`. It stops on Ctrl+C, after every card was downloaded and 30 s passed, or after
  10 minutes idle, and says why.
- Notes printed once: phone and computer must share a Wi-Fi; guest/office networks may block it;
  macOS may ask to allow incoming connections for `node`.
- QR encoding: `qrcode-generator` (MIT, no dependencies), bundled.

## Migration of an existing `~/.tokengraph`

`parseConfig` drops `apiUrl`, `apiKey`, `uploads`, `username`; keeps `deviceId` as `machineId`.
`uploaded.json` is deleted on the first run. The v3 ledger is unchanged. Installed hooks and
schedules keep working (they run `hook-sync` / `sync`).

## Samples contract (cli → site)

`npm run samples -- <outDir>` in `cli/` (script `scripts/samples.ts`, demo data from
`demoUsage`, fixed reference date so output is reproducible) writes:

```
graph-dark.svg  graph-light.svg  graph-compact-dark.svg  graph-compact-light.svg
story-skyline.png  story-receipt.png  story-sticker.png
landing.json      { schema: 1, generatedFrom, totals, families, recentBars, grid }  (documented in the script)
og.png            1200×630 social preview
```

The site commits these under `public/samples/` and never computes them itself.

## Site (`tokengraph-site`)

Next.js 16 static export (`output: 'export'`, `images.unoptimized`), Tailwind 4, the existing
instrument design language (cards, `elevate-*`, theme tokens, IBM Plex). Pages: `/` and `/privacy`
and a 404. No accounts, cookies, database or API routes.

Landing sections: hero ("Your AI coding, as a GitHub-style graph.", `npx tokengraph` copy button,
GitHub star button), the sample README graph (light/dark), how it works in three steps with the
terminal replay (`npx tokengraph` → `tokengraph login` → paste), supported agents, story cards in
phone frames with the QR hand-off told as a short story, a privacy strip ("your usage never leaves
your machine unless you publish it, and then only to your own gist"), FAQ, footer (GitHub, npm, X,
Instagram). Leaderboard, sign-in, dashboard, settings, connect, share, admin and terms (no service
to have terms for) are dropped.

Hosting: Cloudflare Pages (free, works with a private repo, unlimited bandwidth). GitHub Pages
would need a paid plan for a private repo. Optional Cloudflare Web Analytics (free, cookieless)
when `NEXT_PUBLIC_CF_ANALYTICS_TOKEN` is set at build. Domain optional, later.

## Public repo hygiene

README written for stars: hero graph, one-line install, a GIF slot, how it works, privacy,
commands, supported agents, FAQ, "add an adapter" contributing guide. `LICENSE` (MIT), `CLAUDE.md`
adapted (all core/cli invariants kept, server ones removed), `docs/product.md` rewritten for the
local-first vision, `CONTRIBUTING.md`, GitHub Actions CI (test, typecheck, bundle, `npm pack`
size check) on Linux, macOS and Windows with Node 22 and 24 (free on public repos).

## Invariants carried over unchanged

Dedup rules per adapter, totals only grow within a machine, weighted-token formula, null cache
split, pricing tiers and dated rates, `KNOWN_SOURCES`, Cursor event file rules, `canonicalModelId`,
the Claude Code hook returning instantly, `binPath()`, tests never touching the real
`~/.tokengraph`, per-family colours with logos and names (never model ids in the public graph),
per-user percentile levels.

New ones:

- The public graph gist holds only rendered SVGs and a README; model ids and raw counts live only
  in the secret data gist.
- Never sum a machine with itself: within one machine max-merge, across machines sum.
- The QR server binds to one private LAN address, serves only from memory under a random token,
  and always stops.
- The CLI never sends anything anywhere except `api.github.com` / `github.com` /
  `gist.githubusercontent.com` for the logged-in user, and only from `login`, `sync` (and the
  hooks and schedule that run it) and `readme --colors`. `status`, `view` and `story` work offline
  from local files.
- `logout` keeps the machine id: the same machine must never come back under a new id and have
  its logs counted twice.

## Out of scope for v1

Leaderboard (a free PR-based community wall is possible later), a public profile page on the site,
encrypting the data gist, a story key inside the TUI, Homebrew, a custom domain.

## Testing

- Unit: device-flow state machine, token resolution (`gh` and stored), GitHub client errors,
  gist discovery/creation/404 recovery, machine file merge and adoption, publish fingerprints,
  snippet builder, config migration, story data parity with the web version (same fixtures, same
  numbers), PNG dimensions, half-block and inline-image encoders, QR matrix (decoded back with
  `jsqr` in tests), LAN address choice, share server (token, 404s, idle stop, all-downloaded stop).
- Integration: a fake GitHub API server drives `login` (device flow) → `sync` → `readme` →
  second machine → `status` end to end, including gist deletion recovery.
- Visual: rendered story PNGs and graph SVGs inspected by eye after each change to them; the QR
  scanned with a real phone before release.
