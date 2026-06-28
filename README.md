# Open Source AI Router

GitHub Pages frontend → Cloudflare Worker → DeepInfra (open-source models).

## Files

| File | Purpose |
|---|---|
| `index.html` | UI shell |
| `style.css` | Styles |
| `script.js` | Frontend logic — loads config, calls Worker |
| `config.json` | Worker URL + model list |
| `openai-router.js` | Cloudflare Worker (deploy separately) |

## Setup

### 1. Deploy the Cloudflare Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and create a new Worker.
2. Paste the contents of `openai-router.js`.
3. Add a secret named `DEEPINFRA_KEY` with your [DeepInfra API key](https://deepinfra.com).
4. Deploy and copy the Worker URL.

### 2. Configure the frontend

In `config.json`, replace `YOUR_WORKER_URL`:

```json
{
  "worker_url": "https://openai-router.YOURNAME.workers.dev",
  ...
}
```

### 3. Deploy to GitHub Pages

1. Create a repo and add `index.html`, `style.css`, `script.js`, and `config.json` to the root.
2. Enable GitHub Pages: **Settings → Pages → Deploy from branch → main → / (root)**.

## Adding models

Edit the `models` array in `config.json`. Any model on [DeepInfra](https://deepinfra.com/models) works — use its exact model ID:

```json
{ "id": "meta-llama/Meta-Llama-3-8B-Instruct", "label": "Llama 3 8B" }
```
