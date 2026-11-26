# The view shows every machine

The README graph sums every machine's file in the data gist, but `tokengraph view` showed only the
machine it runs on. `story`, `status` and `export --all-machines` already read the other machines from
`machines.json`, the cache a successful publish writes. The view now does too.

## Behaviour

- **Default scope is all machines**: this machine's ledger plus the machines in `machines.json`,
  combined by `combinedUsage` (so `combineMachineUsage`'s rules hold: a machine is never summed with
  itself, a Cursor account counts once). Overview, Models, Agents, Insights totals and cost use it.
- **The cache is the only source.** Opening the view never touches GitHub. Any sync (CLI, hook,
  schedule or the view's own action) refreshes the cache; the view re-reads it after an action.
- **Logged out means this machine only.** The cache of an account the user logged out of is not shown.
- **`a` toggles** between all machines and this machine (also in the palette and the help). The
  choice is not remembered; `tokengraph view --this-machine` starts in this-machine scope and narrows
  `--print` too.
- **Header, row 1 right**: `3 machines · others as of 2h ago` in all-machines scope, `this machine ·
  a for all` in this-machine scope. When the cache is older than 24 hours the line turns to the warn
  colour and ends with `· sync to refresh`. With no other machine cached nothing is shown, and `a`
  says `No other machines yet. Run sync to fetch them.`
- **Local-only data stays local.** Projects, hour data (Insights' hours, the snapshot's busiest hour)
  and plan limits never reach a gist; the hour parts say `this machine` in all-machines scope.
- **Setup recommendations use this machine's sources**, never another machine's: a hook is
  recommended only for an agent used here.

## Not in scope

A per-machine breakdown tab (`tokengraph status` lists machines).
