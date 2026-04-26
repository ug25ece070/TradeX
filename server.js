/**
 * PulseStock — Node.js Backend Server
 * Indian Stock Market (NSE/BSE) — Live Data via Yahoo Finance
 * 
 * SETUP:
 *   npm install express cors node-fetch
 *   node server.js
 *
 * Then open: http://localhost:3000
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');

// Use built-in fetch (Node 18+) or node-fetch
let fetchFn;
try {
  fetchFn = fetch; // Node 18+ built-in
} catch {
  fetchFn = require('node-fetch');
}

const app  = express();
const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_KEY || 'AIzaSyBzS35cmyoLrzosomNVjHqvKyYiPegUPgw';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ─────────────────────────────────────────────────────────────
   ROUTE: /api/quote/:symbol
   Returns current price, change, % change for an NSE symbol
   e.g. GET /api/quote/RELIANCE  →  { price, change, pct, name, ... }
───────────────────────────────────────────────────────────── */
app.get('/api/quote/:symbol', async (req, res) => {
  const raw = req.params.symbol.toUpperCase().trim();
  const sym = toYahoo(raw);

  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
    const data = await yfFetch(url);
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'Symbol not found' });

    const meta    = result.meta;
    const price   = meta.regularMarketPrice;
    const prev    = meta.previousClose || meta.chartPreviousClose;
    const change  = price - prev;
    const pct     = (change / prev) * 100;

    res.json({
      symbol   : raw,
      name     : meta.shortName || meta.longName || raw,
      price    : +price.toFixed(2),
      change   : +change.toFixed(2),
      pct      : +pct.toFixed(2),
      currency : meta.currency || 'INR',
      exchange : meta.exchangeName || 'NSE',
      open     : meta.regularMarketOpen,
      high     : meta.regularMarketDayHigh,
      low      : meta.regularMarketDayLow,
      volume   : meta.regularMarketVolume,
      mktCap   : meta.marketCap,
    });
  } catch (e) {
    console.error('[quote]', sym, e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   ROUTE: /api/history/:symbol?range=1M|3M|6M|1Y
   Returns daily OHLCV history
───────────────────────────────────────────────────────────── */
app.get('/api/history/:symbol', async (req, res) => {
  const raw   = req.params.symbol.toUpperCase().trim();
  const range = req.query.range || '1Y';
  const sym   = toYahoo(raw);
  const yfRange = { '1M':'1mo','3M':'3mo','6M':'6mo','1Y':'1y','5Y':'5y' }[range] || '1y';

  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=${yfRange}`;
    const data = await yfFetch(url);
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No history' });

    const ts    = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const adj   = result.indicators?.adjclose?.[0]?.adjclose || [];

    const history = ts.map((t, i) => ({
      date  : new Date(t * 1000).toISOString().split('T')[0],
      open  : +( quote.open[i]  || 0 ).toFixed(2),
      high  : +( quote.high[i]  || 0 ).toFixed(2),
      low   : +( quote.low[i]   || 0 ).toFixed(2),
      close : +( (adj[i] || quote.close[i] || 0) ).toFixed(2),
      volume: quote.volume[i] || 0,
    })).filter(d => d.close > 0);

    res.json({ symbol: raw, range, history });
  } catch (e) {
    console.error('[history]', sym, e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   ROUTE: /api/movers
   Returns top gainers, losers, most active on NSE
───────────────────────────────────────────────────────────── */
const NIFTY50 = [
  'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK',
  'HINDUNILVR','ITC','SBIN','BHARTIARTL','KOTAKBANK',
  'LT','BAJFINANCE','ASIANPAINT','AXISBANK','MARUTI',
  'SUNPHARMA','TITAN','ULTRACEMCO','WIPRO','HCLTECH',
  'POWERGRID','NTPC','JSWSTEEL','TATAMOTORS','BAJAJFINSV',
  'NESTLEIND','TECHM','ONGC','INDUSINDBK','ADANIENT',
  'M&M','DIVISLAB','CIPLA','DRREDDY','EICHERMOT',
  'COALINDIA','BPCL','HEROMOTOCO','HINDALCO','SBILIFE',
  'BRITANNIA','TATACONSUM','APOLLOHOSP','GRASIM','HDFCLIFE',
  'MRF','BAJAJ-AUTO','ADANIPORTS','UPL','LTIM'
];

app.get('/api/movers', async (req, res) => {
  try {
    // Fetch quotes for a sample of Nifty 50 stocks in parallel
    const sample = NIFTY50.slice(0, 20);
    const results = await Promise.allSettled(
      sample.map(sym => fetchQuickQuote(sym))
    );

    const stocks = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .filter(s => s.pct !== 0);

    stocks.sort((a, b) => b.pct - a.pct);
    const gainers = stocks.filter(s => s.pct > 0).slice(0, 5);
    const losers  = stocks.filter(s => s.pct < 0).reverse().slice(0, 5);
    const byVol   = [...stocks].sort((a, b) => b.volume - a.volume).slice(0, 5);

    res.json({ gainers, losers, volume: byVol });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   ROUTE: /api/search?q=reliance
   Returns matching Indian stocks from our master list
───────────────────────────────────────────────────────────── */
const INDIAN_STOCKS = [
  // Nifty 50 + popular ones with full names
  { sym:'RELIANCE',   name:'Reliance Industries Ltd',         sector:'Oil & Gas' },
  { sym:'TCS',        name:'Tata Consultancy Services',       sector:'IT' },
  { sym:'HDFCBANK',   name:'HDFC Bank Ltd',                   sector:'Banking' },
  { sym:'INFY',       name:'Infosys Ltd',                     sector:'IT' },
  { sym:'ICICIBANK',  name:'ICICI Bank Ltd',                  sector:'Banking' },
  { sym:'HINDUNILVR', name:'Hindustan Unilever Ltd',          sector:'FMCG' },
  { sym:'ITC',        name:'ITC Ltd',                         sector:'FMCG' },
  { sym:'SBIN',       name:'State Bank of India',             sector:'Banking' },
  { sym:'BHARTIARTL', name:'Bharti Airtel Ltd',               sector:'Telecom' },
  { sym:'KOTAKBANK',  name:'Kotak Mahindra Bank',             sector:'Banking' },
  { sym:'LT',         name:'Larsen & Toubro Ltd',             sector:'Infra' },
  { sym:'BAJFINANCE', name:'Bajaj Finance Ltd',               sector:'NBFC' },
  { sym:'ASIANPAINT', name:'Asian Paints Ltd',                sector:'Paints' },
  { sym:'AXISBANK',   name:'Axis Bank Ltd',                   sector:'Banking' },
  { sym:'MARUTI',     name:'Maruti Suzuki India Ltd',         sector:'Auto' },
  { sym:'SUNPHARMA',  name:'Sun Pharmaceutical Industries',   sector:'Pharma' },
  { sym:'TITAN',      name:'Titan Company Ltd',               sector:'Consumer' },
  { sym:'ULTRACEMCO', name:'UltraTech Cement Ltd',            sector:'Cement' },
  { sym:'WIPRO',      name:'Wipro Ltd',                       sector:'IT' },
  { sym:'HCLTECH',    name:'HCL Technologies Ltd',            sector:'IT' },
  { sym:'POWERGRID',  name:'Power Grid Corporation',          sector:'Power' },
  { sym:'NTPC',       name:'NTPC Ltd',                        sector:'Power' },
  { sym:'JSWSTEEL',   name:'JSW Steel Ltd',                   sector:'Steel' },
  { sym:'TATAMOTORS', name:'Tata Motors Ltd',                 sector:'Auto' },
  { sym:'BAJAJFINSV', name:'Bajaj Finserv Ltd',               sector:'NBFC' },
  { sym:'NESTLEIND',  name:'Nestlé India Ltd',                sector:'FMCG' },
  { sym:'TECHM',      name:'Tech Mahindra Ltd',               sector:'IT' },
  { sym:'ONGC',       name:'Oil & Natural Gas Corporation',   sector:'Oil & Gas' },
  { sym:'INDUSINDBK', name:'IndusInd Bank Ltd',               sector:'Banking' },
  { sym:'ADANIENT',   name:'Adani Enterprises Ltd',           sector:'Conglomerate' },
  { sym:'DIVISLAB',   name:'Divi\'s Laboratories Ltd',        sector:'Pharma' },
  { sym:'CIPLA',      name:'Cipla Ltd',                       sector:'Pharma' },
  { sym:'DRREDDY',    name:'Dr Reddy\'s Laboratories',        sector:'Pharma' },
  { sym:'MRF',        name:'MRF Ltd',                         sector:'Tyres' },
  { sym:'BAJAJ-AUTO', name:'Bajaj Auto Ltd',                  sector:'Auto' },
  { sym:'EICHERMOT',  name:'Eicher Motors Ltd',               sector:'Auto' },
  { sym:'COALINDIA',  name:'Coal India Ltd',                  sector:'Mining' },
  { sym:'HEROMOTOCO', name:'Hero MotoCorp Ltd',               sector:'Auto' },
  { sym:'HINDALCO',   name:'Hindalco Industries Ltd',         sector:'Metals' },
  { sym:'BRITANNIA',  name:'Britannia Industries Ltd',        sector:'FMCG' },
  { sym:'TATACONSUM', name:'Tata Consumer Products',          sector:'FMCG' },
  { sym:'APOLLOHOSP', name:'Apollo Hospitals Enterprise',     sector:'Healthcare' },
  { sym:'GRASIM',     name:'Grasim Industries Ltd',           sector:'Cement' },
  { sym:'HDFCLIFE',   name:'HDFC Life Insurance',             sector:'Insurance' },
  { sym:'SBILIFE',    name:'SBI Life Insurance',              sector:'Insurance' },
  { sym:'TATASTEEL',  name:'Tata Steel Ltd',                  sector:'Steel' },
  { sym:'ADANIPORTS', name:'Adani Ports and SEZ',             sector:'Infra' },
  { sym:'TATAPOWER',  name:'Tata Power Company',              sector:'Power' },
  { sym:'ZOMATO',     name:'Zomato Ltd',                      sector:'Food Tech' },
  { sym:'PAYTM',      name:'One97 Communications (Paytm)',    sector:'Fintech' },
  { sym:'NYKAA',      name:'FSN E-Commerce (Nykaa)',          sector:'E-Commerce' },
  { sym:'POLICYBZR',  name:'PB Fintech (PolicyBazaar)',       sector:'Fintech' },
  { sym:'IRCTC',      name:'Indian Railway Catering Corp',    sector:'Transport' },
  { sym:'HAL',        name:'Hindustan Aeronautics Ltd',       sector:'Defence' },
  { sym:'BEL',        name:'Bharat Electronics Ltd',          sector:'Defence' },
  { sym:'DIXON',      name:'Dixon Technologies Ltd',          sector:'Electronics' },
  { sym:'PIDILITIND', name:'Pidilite Industries Ltd',         sector:'Chemicals' },
  { sym:'BERGEPAINT', name:'Berger Paints India',             sector:'Paints' },
  { sym:'HAVELLS',    name:'Havells India Ltd',               sector:'Electricals' },
  { sym:'VOLTAS',     name:'Voltas Ltd',                      sector:'Electricals' },
  { sym:'TVSMOTOR',   name:'TVS Motor Company',               sector:'Auto' },
  { sym:'BANKBARODA', name:'Bank of Baroda',                  sector:'Banking' },
  { sym:'PNB',        name:'Punjab National Bank',            sector:'Banking' },
  { sym:'CANBK',      name:'Canara Bank',                     sector:'Banking' },
  { sym:'IDBI',       name:'IDBI Bank Ltd',                   sector:'Banking' },
  { sym:'FEDERALBNK', name:'Federal Bank Ltd',                sector:'Banking' },
];

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toUpperCase().trim();
  if (!q) return res.json([]);
  const matches = INDIAN_STOCKS.filter(s =>
    s.sym.includes(q) ||
    s.name.toUpperCase().includes(q) ||
    s.sector.toUpperCase().includes(q)
  ).slice(0, 8);
  res.json(matches);
});

/* ─────────────────────────────────────────────────────────────
   ROUTE: /api/indices
   Nifty 50, Sensex, Nifty Bank live data
───────────────────────────────────────────────────────────── */
app.get('/api/indices', async (req, res) => {
  const indices = [
    { sym:'^NSEI',  name:'NIFTY 50' },
    { sym:'^BSESN', name:'SENSEX' },
    { sym:'^NSEBANK', name:'BANK NIFTY' },
  ];
  try {
    const results = await Promise.allSettled(
      indices.map(idx => fetchQuickQuote(idx.sym, false))
    );
    const data = results.map((r, i) => ({
      name  : indices[i].name,
      sym   : indices[i].sym,
      price : r.status==='fulfilled' ? r.value?.price : null,
      pct   : r.status==='fulfilled' ? r.value?.pct   : null,
      change: r.status==='fulfilled' ? r.value?.change: null,
    }));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────── */
app.post('/api/gemini-analysis', async (req, res) => {
  const { sym, name, prices = [], s7v = null, s30v = null } = req.body || {};

  if (!Array.isArray(prices) || prices.length < 2) {
    return res.status(400).json({ error: 'Not enough price history' });
  }

  if (!GEMINI_KEY || GEMINI_KEY === 'YOUR_GEMINI_KEY') {
    return res.status(503).json({ error: 'Gemini API key missing' });
  }

  const first = prices[0];
  const last = prices[prices.length - 1];
  const chg30 = ((last - first) / first * 100).toFixed(2);

  const prompt = `You are a stock analyst for Indian markets. Analyze and reply ONLY with a JSON object - no markdown, no extra text.

Stock: ${name} (${sym}) - NSE India
Last 30 trading days:
- Start: Rs.${first.toFixed(2)}, Current: Rs.${last.toFixed(2)}, Change: ${chg30}%
- High: Rs.${Math.max(...prices).toFixed(2)}, Low: Rs.${Math.min(...prices).toFixed(2)}
- 7-day SMA: ${s7v ? 'Rs.' + Number(s7v).toFixed(2) : 'N/A'}, 30-day SMA: ${s30v ? 'Rs.' + Number(s30v).toFixed(2) : 'N/A'}

Reply with exactly: {"signal":"Bullish","confidence":72,"summary":"2-3 sentence analysis considering Indian market context."}`;

  try {
    const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const gRes = await fetchFn(gUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 200 }
      }),
      signal: AbortSignal.timeout(14000),
    });

    const data = await gRes.json();
    if (!gRes.ok) {
      const detail = data?.error?.message || `HTTP ${gRes.status}`;
      const status = data?.error?.code || gRes.status;
      return res.status(status).json({ error: detail });
    }
    if (data?.error) throw new Error(data.error.message);

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = raw.replace(/```json|```/gi, '').trim();
    const match = cleaned.match(/\{[\s\S]*?"signal"[\s\S]*?\}/) || raw.match(/\{[\s\S]*?"signal"[\s\S]*?\}/);
    if (!match) throw new Error('Gemini did not return valid JSON');

    const parsed = JSON.parse(match[0]);
    res.json({
      signal: (parsed.signal || 'Neutral').trim(),
      confidence: Math.min(Math.max(parseInt(parsed.confidence) || 65, 50), 95),
      summary: parsed.summary || '',
    });
  } catch (e) {
    console.error('[gemini-analysis]', e.message);
    res.status(502).json({ error: e.message });
  }
});

function toYahoo(sym) {
  // Map app symbols to the current Yahoo Finance symbols before adding the exchange suffix.
  const aliases = {
    ZOMATO: 'ETERNAL',
    TATAMOTORS: 'TMPV',
  };

  // Strip .BSE suffix, normalize known aliases, then add .NS for NSE
  const base = sym.replace(/\.(BSE|NSE)$/, '');
  const mapped = aliases[base] || base;
  const clean = mapped.replace('&', '%26');
  if (sym.includes('^')) return sym;           // index
  if (sym.endsWith('.NS') || sym.endsWith('.BO')) return sym;
  return clean + '.NS';
}

async function yfFetch(url) {
  const res = await fetchFn(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept'    : 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchQuickQuote(sym, addNS = true) {
  const yfSym = addNS ? toYahoo(sym) : sym;
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSym}?interval=1d&range=5d`;
    const data = await yfFetch(url);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price  = meta.regularMarketPrice;
    const prev   = meta.previousClose || meta.chartPreviousClose;
    const change = price - prev;
    const pct    = (change / prev) * 100;
    return {
      symbol: sym,
      name  : meta.shortName || sym,
      price : +price.toFixed(2),
      change: +change.toFixed(2),
      pct   : +pct.toFixed(2),
      volume: meta.regularMarketVolume || 0,
    };
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────
   SERVE FRONTEND
───────────────────────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 PulseStock server running at http://localhost:${PORT}`);
  console.log(`   Indian Stock Market — Live NSE/BSE Data\n`);
});
