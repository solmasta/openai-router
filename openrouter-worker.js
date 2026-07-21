const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
};

// Shared-secret check so a bare Worker URL (visible in the page source) can't
// be hit directly by scanners/bots to spend the OPENROUTER_KEY budget. Not a
// substitute for real auth - the secret ships in client JS - but it stops
// casual/automated abuse of the raw URL.
function checkAuth(request, env) {
  const provided = request.headers.get("X-App-Secret");
  return !!env.APP_SECRET && provided === env.APP_SECRET;
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

    // Live model list endpoint
    if (request.method === "GET" && url.pathname === "/models") {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: {
          "Authorization": `Bearer ${env.OPENROUTER_KEY}`,
          "HTTP-Referer": "https://solmasta.github.io/openai-router",
        }
      });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", ...CORS }
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

    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENROUTER_KEY}`,
        "HTTP-Referer": "https://solmasta.github.io/openai-router",
        "X-Title": "ai-router",
      },
      body: JSON.stringify(body),
    });

    if (body.stream) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS }
      });
    }

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...CORS }
    });
  },
};
