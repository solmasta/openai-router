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
