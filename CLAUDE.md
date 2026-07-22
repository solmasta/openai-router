# openai-router

Single-file PWA (`index.html`) - all frontend logic lives in two inline
`<script>` blocks. Backed by several Cloudflare Workers (`openai-router.js`,
`claude-worker.js`, `openrouter-worker.js`, `github-ops-worker.js`), each with
its own `wrangler*.jsonc`/`.toml` config.

## Before committing any change to index.html

Run the regression suite and make sure it passes:

```
# one-time per session: serve the repo and have Playwright's Chromium available
NODE_PATH=/opt/node22/lib/node_modules npx http-server . -p 8899 --silent &

NODE_PATH=/opt/node22/lib/node_modules node tests/regression.js
```

It drives the real app in headless Chromium and checks the flows that have
actually broken before: a failed send keeping the message usable (Regen +
tab storage), vision model auto-switch/restore, tab isolation and
switch-back, memory add/delete, and profile isolation. Network calls to the
real workers fail in most sandboxes (no egress) - that's expected and
already filtered out of the error count; the assertions that matter check
app state, not whether a live model reply came back.

If you change one of the flows above, update `tests/regression.js` in the
same commit rather than letting it drift out of sync with what it claims to
cover.

## Bump the version number with every user-visible change

The version string (two spots: the header `.wm span`, and the Settings modal
title - `grep -n "v5\."` finds both) is how the user confirms a deploy
actually landed, especially on a PWA where the service worker can serve a
stale cached copy. Bump it in the same commit as any change they'd notice -
not just feature work, bug fixes too. Skipping a bump because a change
"felt small" is exactly what makes the version number useless as a signal.
