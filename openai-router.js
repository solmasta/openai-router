const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Diagnostic: calls DeepInfra directly and shows raw response
    if (request.method === "GET") {
      const testRes = await fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.DEEPINFRA_KEY}`,
        },
        body: JSON.stringify({
          model: "mistralai/Mistral-7B-Instruct-v0.3",
          messages: [{ role: "user", content: "Say hi" }],
          max_tokens: 10
        })
      });
      const text = await testRes.text();
      return new Response(JSON.stringify({
        key_length: env.DEEPINFRA_KEY ? env.DEEPINFRA_KEY.length : 0,
        deepinfra_status: testRes.status,
        deepinfra_response: text
      }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    const upstream = await fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.DEEPINFRA_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (body.stream) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          ...CORS,
        },
      });
    }

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  },
};
