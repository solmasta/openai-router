const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
};

// Shared-secret check so a bare Worker URL (visible in the page source) can't
// be hit directly by scanners/bots to spend the DEEPINFRA_KEY budget. Not a
// substitute for real auth - the secret ships in client JS - but it stops
// casual/automated abuse of the raw URL.
function checkAuth(request, env) {
  const provided = request.headers.get("X-App-Secret");
  return !!env.APP_SECRET && provided === env.APP_SECRET;
}

async function handleSearch(query, env) {
  // Defense in depth: cap query length regardless of what the client sends,
  // so a stray large paste can never produce an oversized downstream request.
  query = (query || "").slice(0, 300);
  const q = query.toLowerCase();
  const results = [];

  // Crypto price detection - 60+ coins, free via CoinGecko
  const cryptoMap = {
    'xrp':'ripple','ripple':'ripple','bitcoin':'bitcoin','btc':'bitcoin',
    'ethereum':'ethereum','eth':'ethereum','solana':'solana','sol':'solana',
    'dogecoin':'dogecoin','doge':'dogecoin','cardano':'cardano','ada':'cardano',
    'bnb':'binancecoin','binance coin':'binancecoin','avalanche':'avalanche-2','avax':'avalanche-2',
    'chainlink':'chainlink','link':'chainlink','polygon':'matic-network','matic':'matic-network',
    'sui':'sui','pepe':'pepe','shiba':'shiba-inu','shib':'shiba-inu',
    'polkadot':'polkadot','dot':'polkadot','litecoin':'litecoin','ltc':'litecoin',
    'tron':'tron','trx':'tron','stellar':'stellar','xlm':'stellar',
    'hedera':'hedera-hashgraph','hbar':'hedera-hashgraph','near':'near',
    'aptos':'aptos','apt':'aptos','arbitrum':'arbitrum','arb':'arbitrum',
    'optimism':'optimism','uniswap':'uniswap','uni':'uniswap',
    'cosmos':'cosmos','atom':'cosmos','filecoin':'filecoin','fil':'filecoin',
    'internet computer':'internet-computer','icp':'internet-computer',
    'monero':'monero','xmr':'monero','ethereum classic':'ethereum-classic','etc':'ethereum-classic',
    'vechain':'vechain','vet':'vechain','algorand':'algorand','algo':'algorand',
    'toncoin':'the-open-network','ton':'the-open-network','bonk':'bonk',
    'render':'render-token','rndr':'render-token','injective':'injective-protocol','inj':'injective-protocol',
    'fantom':'fantom','ftm':'fantom','tezos':'tezos','xtz':'tezos',
    'sei':'sei-network','celestia':'celestia','tia':'celestia',
    'usdc':'usd-coin','usdt':'tether','tether':'tether','dai':'dai',
    'worldcoin':'worldcoin-wld','wld':'worldcoin-wld','pyth':'pyth-network',
    'jupiter':'jupiter-exchange-solana','jup':'jupiter-exchange-solana',
    'wif':'dogwifcoin','dogwifhat':'dogwifcoin','floki':'floki',
    'immutable':'immutable-x','imx':'immutable-x','sandbox':'the-sandbox',
    'decentraland':'decentraland','mana':'decentraland','axie':'axie-infinity',
    'gala':'gala','flow':'flow','theta':'theta-token',
    'kaspa':'kaspa','kas':'kaspa','mantle':'mantle','mnt':'mantle',
    'ondo':'ondo-finance','pendle':'pendle','ethena':'ethena','ena':'ethena',
  };
  const foundCoins = [];
  for (const [key, id] of Object.entries(cryptoMap)) {
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(q)) foundCoins.push(id);
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

  // Weather - free via wttr.in
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
      results.push(`Weather in ${city}: ${desc}, ${cur.temp_F}°F (${cur.temp_C}°C), feels like ${cur.FeelsLikeF}°F, humidity ${cur.humidity}%, wind ${cur.windspeedMiles}mph`);
      const today = wData.weather[0];
      results.push(`Today: High ${today.maxtempF}°F / Low ${today.mintempF}°F`);
    } catch(e) {}
  }

  // Stock price - free via Stooq
  const stockMatch = q.match(/\$([a-z]{1,5})\b/i);
  const stockWords = q.match(/\b(stock|share price|shares of)\b/);
  if (stockMatch || stockWords) {
    let ticker = stockMatch ? stockMatch[1].toUpperCase() : null;
    if (!ticker) {
      const tickerMap = {
        'apple':'AAPL','microsoft':'MSFT','google':'GOOGL','alphabet':'GOOGL',
        'amazon':'AMZN','tesla':'TSLA','meta':'META','facebook':'META',
        'nvidia':'NVDA','netflix':'NFLX','disney':'DIS','coinbase':'COIN',
        'paypal':'PYPL','visa':'V','mastercard':'MA','walmart':'WMT',
        'jpmorgan':'JPM','berkshire':'BRK-B','johnson':'JNJ','exxon':'XOM',
        'chevron':'CVX','boeing':'BA','intel':'INTC','amd':'AMD',
        'qualcomm':'QCOM','ford':'F','general motors':'GM','starbucks':'SBUX',
        'mcdonalds':'MCD','nike':'NKE','ibm':'IBM','oracle':'ORCL',
        'salesforce':'CRM','adobe':'ADBE','uber':'UBER','airbnb':'ABNB',
        'palantir':'PLTR','micron':'MU','broadcom':'AVGO',
      };
      for (const [name, tick] of Object.entries(tickerMap)) {
        if (q.includes(name)) { ticker = tick; break; }
      }
    }
    if (ticker) {
      try {
        const sRes = await fetch(`https://stooq.com/q/l/?s=${ticker.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`);
        const csv = await sRes.text();
        const lines = csv.trim().split('\n');
        if (lines.length > 1) {
          const [sym, date, time, open, high, low, close, vol] = lines[1].split(',');
          if (close && close !== 'N/D') {
            results.push(`${ticker} stock: $${close} (open $${open}, high $${high}, low $${low}) as of ${date} ${time}`);
          }
        }
      } catch(e) {}
    }
  }

  // Sports scores - free via ESPN
  const sportsWords = /\b(score|game|match|playing tonight|vs\.?|versus)\b/;
  const leagueMap = {
    'nfl':'football/nfl','nba':'basketball/nba','mlb':'baseball/mlb',
    'nhl':'hockey/nhl','ncaa football':'football/college-football',
    'ncaa basketball':'basketball/mens-college-basketball',
    'premier league':'soccer/eng.1','champions league':'soccer/uefa.champions',
  };
  if (sportsWords.test(q)) {
    let league = null;
    for (const [key, path] of Object.entries(leagueMap)) {
      if (q.includes(key)) { league = path; break; }
    }
    if (league) {
      try {
        const eRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${league}/scoreboard`);
        const eData = await eRes.json();
        const events = (eData.events || []).slice(0, 5);
        events.forEach(ev => {
          const comp = ev.competitions[0];
          const teams = comp.competitors.map(c => `${c.team.abbreviation} ${c.score || ''}`).join(' vs ');
          const status = comp.status.type.shortDetail;
          results.push(`${teams} - ${status}`);
        });
      } catch(e) {}
    }
  }

  // General web search via Tavily (if configured) - real any-topic web
  // results, not just topics with a Wikipedia-style summary. Only called
  // when the free structured checks above (crypto/weather/stock/sports)
  // didn't already answer the query, to keep free-tier quota usage
  // proportional to how often a search was actually needed.
  if (results.length === 0 && env.TAVILY_API_KEY) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const tRes = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: env.TAVILY_API_KEY,
          query: query,
          max_results: 4,
          search_depth: 'basic'
        }),
        signal: ac.signal
      });
      clearTimeout(timer);
      const tData = await tRes.json();
      if (tData.answer) {
        results.push(`Answer: ${tData.answer}`);
      }
      if (tData.results && tData.results.length) {
        tData.results.slice(0, 4).forEach(r => {
          results.push(`${r.title}: ${(r.content || '').slice(0, 300)} (source: ${r.url})`);
        });
      }
    } catch(e) {}
  }

  // Fallback - DuckDuckGo Instant Answer API, free, zero setup, no key.
  // Used when Tavily isn't configured or didn't return anything useful.
  if (results.length === 0) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 4000);
      const dRes = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
        { signal: ac.signal }
      );
      clearTimeout(timer);
      const dData = await dRes.json();

      if (dData.AbstractText) {
        results.push(`${dData.Heading || 'Summary'}: ${dData.AbstractText} (source: ${dData.AbstractSource || 'DuckDuckGo'})`);
      }
      if (dData.Answer) {
        results.push(`Answer: ${dData.Answer}`);
      }
      if (dData.Definition) {
        results.push(`Definition: ${dData.Definition} (source: ${dData.DefinitionSource || ''})`);
      }
      if (results.length === 0 && dData.RelatedTopics && dData.RelatedTopics.length > 0) {
        dData.RelatedTopics.slice(0, 3).forEach(t => {
          if (t.Text) results.push(t.Text);
        });
      }
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

    if (!checkAuth(request, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json", ...CORS }
      });
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
