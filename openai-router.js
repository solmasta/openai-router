const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handleSearch(query, env) {
  const q = query.toLowerCase();
  const results = [];

  // Crypto price detection
  const cryptoMap = {
    'xrp': 'ripple', 'ripple': 'ripple', 'bitcoin': 'bitcoin', 'btc': 'bitcoin',
    'ethereum': 'ethereum', 'eth': 'ethereum', 'solana': 'solana', 'sol': 'solana',
    'dogecoin': 'dogecoin', 'doge': 'dogecoin', 'cardano': 'cardano', 'ada': 'cardano',
    'bnb': 'binancecoin', 'binance': 'binancecoin', 'avalanche': 'avalanche-2',
    'avax': 'avalanche-2', 'chainlink': 'chainlink', 'link': 'chainlink',
    'polygon': 'matic-network', 'matic': 'matic-network', 'sui': 'sui',
    'pepe': 'pepe', 'shiba': 'shiba-inu', 'shib': 'shiba-inu',
  };
  const foundCoins = [];
  for (const [key, id] of Object.entries(cryptoMap)) {
    if (q.includes(key)) foundCoins.push(id);
  }
  const uniqueCoins = [...new Set(foundCoins)];

  if (uniqueCoins.length > 0) {
    try {
      const cgRes = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${uniqueCoins.join(',')}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`
      );
      const cgData = await cgRes.json();
      for (const [coin, data] of Object.entries(cgData)) {
        const change = data.usd_24h_change ? data.usd_24h_change.toFixed(2) : 'N/A';
        const mcap = data.usd_market_cap ? `$${(data.usd_market_cap/1e9).toFixed(2)}B mcap` : '';
        results.push(`${coin.toUpperCase()}: $${data.usd.toLocaleString()} (${change > 0 ? '+' : ''}${change}% 24h) ${mcap}`);
      }
    } catch(e) {}
  }

  // Weather detection
  const weatherMatch = q.match(/weather\s+(?:in\s+)?([a-z\s]+?)(?:\?|$|today|tomorrow|this week)/);
  const isWeather = q.includes('weather') || q.includes('temperature') || q.includes('forecast');
  if (isWeather) {
    const loc = weatherMatch ? weatherMatch[1].trim().replace(/\s+/g, '+') : 'auto';
    try {
      const wRes = await fetch(`https://wttr.in/${loc}?format=j1`);
      const wData = await wRes.json();
      const cur = wData.current_condition[0];
      const area = wData.nearest_area[0];
      const city = area.areaName[0].value + ', ' + area.country[0].value;
      const desc = cur.weatherDesc[0].value;
      const tempF = cur.temp_F;
      const tempC = cur.temp_C;
      const feels = cur.FeelsLikeF;
      const humidity = cur.humidity;
      const wind = cur.windspeedMiles;
      results.push(`Weather in ${city}: ${desc}, ${tempF}°F (${tempC}°C), feels like ${feels}°F, humidity ${humidity}%, wind ${wind}mph`);
      // Today's forecast
      const today = wData.weather[0];
      results.push(`Today: High ${today.maxtempF}°F / Low ${today.mintempF}°F`);
    } catch(e) {}
  }

  // General web search via Brave (if key set)
  if (env.BRAVE_KEY && results.length === 0) {
    try {
      const bRes = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': env.BRAVE_KEY } }
      );
      const bData = await bRes.json();
      const hits = (bData.web && bData.web.results) || [];
      hits.slice(0, 4).forEach(r => {
        results.push(`${r.title}: ${r.description || ''} [${r.url}]`);
      });
    } catch(e) {}
  }

  return results;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "GET" && url.pathname === "/models") {
      const res = await fetch("https://api.deepinfra.com/v1/openai/models", {
        headers: { "Authorization": `Bearer ${env.DEEPINFRA_KEY}` }
      });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok", key_set: !!env.DEEPINFRA_KEY }), {
        headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    if (request.method === "POST" && url.pathname === "/search") {
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ results: [] }), { headers: { "Content-Type": "application/json", ...CORS } }); }
      const results = await handleSearch(body.query || '', env);
      return new Response(JSON.stringify({ results, timestamp: new Date().toISOString() }), {
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
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS }
      });
    }

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...CORS }
    });
  },
};
