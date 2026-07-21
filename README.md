# AI Router

A single-file PWA chat client (`index.html`) that talks to three Cloudflare Workers:

- **DeepInfra** — open-source models (Llama, Qwen, DeepSeek, Mistral, Gemma).
- **OpenRouter** — uncensored/roleplay models plus a few free ones.
- **Claude** — Anthropic's Claude models (Opus, Sonnet, Haiku) with your API credits.

Everything the browser needs — markup, CSS, and JS — lives inline in `index.html`. There's no build step and no separate `config.json`/`script.js`/`style.css` to keep in sync; model lists, worker URLs, and system-prompt defaults are all defined directly inside `index.html`'s `<script>` block (`BACKENDS`, `DEFAULT_PROMPTS`).

## Files

| File | Purpose |
|---|---|
| `index.html` | The entire app — UI, styles, and logic |
| `manifest.json` | PWA manifest (install to home screen) |
| `sw.js` | Service worker — offline caching |
| `icon-32.png` / `icon-192.png` / `icon-512.png` | App icons |
| `openai-router.js` | Cloudflare Worker — proxies DeepInfra + a free web-search endpoint |
| `openrouter-worker.js` | Cloudflare Worker — proxies OpenRouter |
| `claude-worker.js` | Cloudflare Worker — proxies Claude API, converts OpenAI format to Claude format |
| `wrangler.jsonc` | Wrangler config for the DeepInfra worker |
| `wrangler-openaiworker.toml` | Wrangler config for the OpenRouter worker |
| `import-prompts.html` | Standalone page to bulk-import the default system prompts into `localStorage`. Optional — `index.html` already has an "Import Defaults" button that does the same thing from within the app. |

## Setup

### 1. Pick a shared secret

Generate a random string (e.g. `openssl rand -hex 32`) — this is `APP_SECRET`. All Workers check it on every request so the raw Worker URL (visible in `index.html`'s source) can't be hit directly by bots/scanners to spend your API credits. It's not real auth — the same string ships in the client JS, so anyone who reads the repo can read it too — but it does stop casual/automated abuse of the bare URL.

### 2. Deploy the DeepInfra Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and create a new Worker.
2. Paste the contents of `openai-router.js`.
3. Add a secret named `DEEPINFRA_KEY` with your [DeepInfra API key](https://deepinfra.com).
4. Add a secret named `APP_SECRET` with the string from step 1.
5. Deploy and copy the Worker URL.

### 3. Deploy the OpenRouter Worker

1. Create a second Worker.
2. Paste the contents of `openrouter-worker.js`.
3. Add a secret named `OPENROUTER_KEY` with your [OpenRouter API key](https://openrouter.ai).
4. Add a secret named `APP_SECRET` with the **same** string from step 1.
5. Deploy and copy the Worker URL.

### 4. Deploy the Claude Worker

1. Create a third Worker.
2. Paste the contents of `claude-worker.js`.
3. Add a secret named `ANTHROPIC_API_KEY` with your [Anthropic API key](https://console.anthropic.com/api/keys).
4. Add a secret named `APP_SECRET` with the **same** string from step 1.
5. Deploy and copy the Worker URL.

### 5. Point the frontend at your Workers

In `index.html`, find these lines near the top of the `<script>` block:

```js
var DI_URL="https://openai-router-chat.lukedorsett.workers.dev";
var OR_URL="https://openaiworker.lukedorsett.workers.dev";
var CLAUDE_URL="https://claude-worker.lukedorsett.workers.dev";
var APP_SECRET="CHANGE_ME_APP_SECRET";
```

Replace `DI_URL`, `OR_URL`, and `CLAUDE_URL` with your own Worker URLs from steps 2–4, and `APP_SECRET` with the exact string you set as the `APP_SECRET` secret on all three Workers.

### 6. Deploy to GitHub Pages

1. Push `index.html`, `manifest.json`, `sw.js`, and the icon files to the root of a repo.
2. Enable GitHub Pages: **Settings → Pages → Deploy from branch → main → / (root)**.
3. If the repo is a *project* page (`username.github.io/reponame`), the service worker registration in `index.html` (`navigator.serviceWorker.register('/reponame/sw.js')`) must match your repo name — update the path if you rename the repo.

## Adding models

Edit the `BACKENDS` object inside `index.html`'s `<script>` block — each backend (`deepinfra`, `openrouter`, `claude`) has a `models` array. Any model your provider serves works — use its exact model ID:

```js
{ id:"meta-llama/Meta-Llama-3-8B-Instruct", label:"Llama 3 8B", cat:"Everyday", desc:"..." }
```

Claude model IDs: `claude-opus-4-1`, `claude-sonnet-4-20250514`, `claude-haiku-4-5-20251001`.

## Security note

All Workers check the `X-App-Secret` header against an `APP_SECRET` secret (set up above) before doing anything else, so a bare Worker URL discovered by a scanner or bot can't spend your API credits without also knowing that string. That said, this repo is public and `APP_SECRET` is embedded in `index.html`'s client-side JS — anyone who actually reads the source (here or via view-source on the live page) can read it too. This raises the bar against casual/automated abuse of the raw URL; it isn't a substitute for real per-user auth. If that's not enough for your usage, consider adding Cloudflare rate limiting on top.

**Claude API key in particular:** Store your Anthropic API key as a Cloudflare secret. Never commit it to the repo or hard-code it in the frontend. The same applies to DeepInfra and OpenRouter keys.
