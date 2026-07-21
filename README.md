# AI Router

A single-file PWA chat client (`index.html`) that talks to two Cloudflare Workers:

- **DeepInfra** — open-source models (Llama, Qwen, DeepSeek, Mistral, Gemma).
- **OpenRouter** — uncensored/roleplay models plus a few free ones.

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
| `wrangler.jsonc` | Wrangler config for the DeepInfra worker |
| `wrangler-openaiworker.toml` | Wrangler config for the OpenRouter worker |
| `import-prompts.html` | Standalone page to bulk-import the default system prompts into `localStorage`. Optional — `index.html` already has an "Import Defaults" button that does the same thing from within the app. |

## Setup

### 1. Deploy the DeepInfra Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and create a new Worker.
2. Paste the contents of `openai-router.js`.
3. Add a secret named `DEEPINFRA_KEY` with your [DeepInfra API key](https://deepinfra.com).
4. Deploy and copy the Worker URL.

### 2. Deploy the OpenRouter Worker

1. Create a second Worker.
2. Paste the contents of `openrouter-worker.js`.
3. Add a secret named `OPENROUTER_KEY` with your [OpenRouter API key](https://openrouter.ai).
4. Deploy and copy the Worker URL.

### 3. Point the frontend at your Workers

In `index.html`, find this line near the top of the `<script>` block:

```js
var DI_URL="https://openai-router-chat.lukedorsett.workers.dev";
var OR_URL="https://openaiworker.lukedorsett.workers.dev";
```

Replace both with your own Worker URLs from steps 1–2.

### 4. Deploy to GitHub Pages

1. Push `index.html`, `manifest.json`, `sw.js`, and the icon files to the root of a repo.
2. Enable GitHub Pages: **Settings → Pages → Deploy from branch → main → / (root)**.
3. If the repo is a *project* page (`username.github.io/reponame`), the service worker registration in `index.html` (`navigator.serviceWorker.register('/reponame/sw.js')`) must match your repo name — update the path if you rename the repo.

## Adding models

Edit the `BACKENDS` object inside `index.html`'s `<script>` block — each backend (`deepinfra`, `openrouter`) has a `models` array. Any model your provider serves works — use its exact model ID:

```js
{ id:"meta-llama/Meta-Llama-3-8B-Instruct", label:"Llama 3 8B", cat:"Everyday", desc:"..." }
```

## Security note

Both Workers accept requests from any origin with no auth check — the Worker URLs are visible in `index.html`'s source, so anyone with the URL can call them and spend your API credits. This is fine for personal/low-traffic use but worth knowing about; adding an origin check, a shared-secret header, or Cloudflare rate limiting would tighten this up if it becomes a concern.
