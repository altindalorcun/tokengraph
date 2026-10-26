# Security policy

## Reporting a vulnerability

Please report security problems privately, using GitHub's **Report a vulnerability** button on the
[Security tab](https://github.com/altindalorcun/tokengraph/security/advisories/new) of this
repository (a private security advisory). Please do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and which version (`tokengraph --version`) and
operating system you used.

tokengraph is a volunteer project. We answer on a best-effort basis, usually within a few days,
and fix confirmed problems as quickly as we can. There is no bug bounty.

## What is in scope

- **GitHub credentials.** The OAuth token (or the path to the `gh` CLI) stored in
  `~/.tokengraph/config.json`, which should be readable only by you (mode 0600), and anything that
  could leak or widen it. tokengraph asks for the `gist` scope only.
- **Gist publishing.** What goes into the public graph gist and the secret data gist, and any way
  to make tokengraph write somewhere else or expose more than documented (the public gist should
  hold SVGs and a README only; model ids and raw counts belong to the secret data gist).
- **The QR share server** behind `tokengraph story`: it should bind to one private LAN address,
  serve only the rendered cards from memory under a random token, and always stop.
- **The Cursor sign-in token.** While the Cursor fetch is on, tokengraph reads Cursor's sign-in
  token from Cursor's local database (read-only) and sends it to `cursor.com` / `www.cursor.com`
  only, for one request, checking every redirect itself. It should never be stored, logged,
  printed, published or sent anywhere else, and neither should the Cursor user id or e-mail.
- **Hooks and the schedule** that `install-hook` and `schedule` add to your agents and your
  system, and the files tokengraph reads from agents' local directories (a crafted log should not
  be able to run code or write outside `~/.tokengraph`).

## What is out of scope

- Vulnerabilities in the agents tokengraph reads (Claude Code, Codex CLI and so on), in GitHub
  itself, or in Node.js.
- Anything that needs an attacker who already controls your user account or your machine.
- The secret data gist being "unlisted, not private": that is how GitHub secret gists work, and
  the data in it is token counters plus the machine fields the README lists (a random machine id,
  a label, a hashed fingerprint, the CLI version and a hashed Cursor account key). It is documented
  in the README.

## Supported versions

Only the latest published version of `tokengraph` receives fixes.
