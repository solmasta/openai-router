const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
};

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

    // Public endpoint: get APP_SECRET for frontend - validates origin only
    if (request.method === "GET" && url.pathname === "/secret") {
      const origin = request.headers.get("Origin") || request.headers.get("Referer") || "";
      const allowedOrigins = [
        "https://solmasta.github.io",
        "http://localhost:8000",
        "http://localhost:3000",
        "http://127.0.0.1:8000",
        "http://127.0.0.1:3000"
      ];

      if (!allowedOrigins.some(o => origin.startsWith(o))) {
        return new Response(JSON.stringify({ error: "Origin not allowed" }), {
          status: 403, headers: { "Content-Type": "application/json", ...CORS }
        });
      }

      return new Response(JSON.stringify({ secret: env.APP_SECRET }), {
        headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    if (!checkAuth(request, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    // Live model list endpoint - return hardcoded Claude models
    if (request.method === "GET" && url.pathname === "/models") {
      const models = {
        data: [
          { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
          { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
          { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
        ]
      };
      return new Response(JSON.stringify(models), {
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

    // Convert OpenAI format to Claude format
    const claudeBody = {
      model: body.model,
      messages: [],
      stream: body.stream || false,
    };

    // Extract system message if present (should be first message with role="system")
    let systemPrompt = body.system;
    if (body.messages && body.messages.length > 0) {
      if (body.messages[0].role === "system") {
        systemPrompt = body.messages[0].content;
        claudeBody.messages = body.messages.slice(1);
      } else {
        claudeBody.messages = body.messages;
      }
    }

    if (systemPrompt) {
      claudeBody.system = systemPrompt;
    }

    // Add max_tokens - required by Claude API
    if (body.max_tokens) {
      claudeBody.max_tokens = body.max_tokens;
    } else {
      claudeBody.max_tokens = 4096;
    }

    // Add temperature if provided
    if (body.temperature !== undefined) {
      claudeBody.temperature = body.temperature;
    }

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(claudeBody),
    });

    if (body.stream) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS }
      });
    }

    // For non-streaming, Claude returns a different format, so we need to convert it
    if (!body.stream) {
      const claudeResp = await upstream.json();

      // Convert Claude response to OpenAI format for compatibility
      const openaiResp = {
        id: claudeResp.id || "claude-response",
        object: "text_completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: claudeResp.content && claudeResp.content[0] && claudeResp.content[0].text ? claudeResp.content[0].text : ""
          },
          finish_reason: claudeResp.stop_reason === "end_turn" ? "stop" : claudeResp.stop_reason || "stop"
        }],
        usage: claudeResp.usage || {}
      };

      return new Response(JSON.stringify(openaiResp), {
        status: upstream.status,
        headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...CORS }
    });
  },
};
