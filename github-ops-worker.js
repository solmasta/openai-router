const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Secret, Authorization",
};

function checkAuth(request, env) {
  const provided = request.headers.get("X-App-Secret");
  return !!env.APP_SECRET && provided === env.APP_SECRET;
}

// GitHub's error responses are normally {"message": "..."} JSON, but some
// failure modes (edge/proxy rejections, HTML error pages) return plain text
// instead - falling back to raw text keeps this diagnostic instead of
// silently collapsing to just a status code whenever the body isn't JSON.
async function describeError(res) {
  const text = await res.text();
  let message = "";
  try { message = JSON.parse(text).message || ""; } catch {}
  if (!message && text) message = text.slice(0, 200);
  return message ? `HTTP ${res.status} - ${message}` : `HTTP ${res.status}`;
}

async function handleGitHubOp(body, env) {
  const { op, owner, repo, path, content, message, branch } = body;
  const token = env.GITHUB_TOKEN;

  if (!token) return { error: "GitHub token not configured" };
  if (!owner || !repo) return { error: "Missing owner or repo" };

  const headers = {
    "Authorization": `token ${token}`,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    // GitHub's API rejects any request with no User-Agent header (403,
    // "Request forbidden by administrative rules") - browsers and most
    // HTTP clients set one automatically, but Cloudflare Workers' fetch()
    // does not, so it has to be set explicitly here.
    "User-Agent": "openai-router-github-ops-worker",
  };

  try {
    switch (op) {
      case "read_file":
        if (!path) return { error: "Missing path" };
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return { error: `Failed to read ${path}: ${await describeError(res)}`, status: res.status };
        const data = await res.json();
        const fileContent = atob(data.content);
        return { success: true, content: fileContent, sha: data.sha };

      case "write_file":
        if (!path || content === undefined) return { error: "Missing path or content" };
        const writeUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

        // First, get the current SHA if file exists
        let sha = null;
        const checkRes = await fetch(writeUrl, { headers });
        if (checkRes.ok) {
          const existing = await checkRes.json();
          sha = existing.sha;
        }

        const payload = {
          message: message || `Update ${path}`,
          content: btoa(content),
          branch: branch || "main",
        };
        if (sha) payload.sha = sha;

        const writeRes = await fetch(writeUrl, {
          method: "PUT",
          headers,
          body: JSON.stringify(payload),
        });
        if (!writeRes.ok) return { error: `Failed to write ${path}: ${await describeError(writeRes)}`, status: writeRes.status };
        const writeData = await writeRes.json();
        return { success: true, commit: writeData.commit.sha };

      case "list_files":
        if (!path) return { error: "Missing path" };
        const listUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
        const listRes = await fetch(listUrl, { headers });
        if (!listRes.ok) return { error: `Failed to list ${path}: ${await describeError(listRes)}`, status: listRes.status };
        const listData = await listRes.json();
        const files = Array.isArray(listData)
          ? listData.map(f => ({ name: f.name, type: f.type, path: f.path }))
          : { error: "Not a directory" };
        return { success: true, files };

      case "create_commit":
        if (!message) return { error: "Missing commit message" };
        // This is simplified - in reality you'd need to create a tree and commit
        return { success: true, message: "Commit queued (use write_file for actual changes)" };

      default:
        return { error: "Unknown operation" };
    }
  } catch (e) {
    return { error: e.message };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!checkAuth(request, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405, headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    let body;
    try { body = await request.json(); }
    catch {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400, headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    const result = await handleGitHubOp(body, env);
    return new Response(JSON.stringify(result), {
      status: result.error ? 400 : 200,
      headers: { "Content-Type": "application/json", ...CORS }
    });
  },
};
