// Finnhub Real-Time Market Data Proxy
const https = require('https');

const FINNHUB_KEY = 'd6umfm9r01qig5453qegd6umfm9r01qig5453qf0';
const cache = {};
const CACHE_TTL = 10000; // 10s cache

function finnhubFetch(path) {
  return new Promise((resolve, reject) => {
    const url = `${path}${path.includes('?') ? '&' : '?'}token=${FINNHUB_KEY}`;
    const req = https.request({
      hostname: 'finnhub.io', path: `/api/v1${url}`, method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: data.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Finnhub timeout')); });
    req.end();
  });
}

exports.handler = async (event) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    // Cache check
    const ck = JSON.stringify(body);
    if (cache[ck] && Date.now() - cache[ck].ts < CACHE_TTL) {
      return { statusCode: 200, headers: H, body: JSON.stringify({ ...cache[ck].data, _cached: true }) };
    }

    let result;
    switch (action) {
      case 'quote': {
        // Single stock quote
        result = await finnhubFetch(`/quote?symbol=${encodeURIComponent(body.symbol || '')}`);
        break;
      }
      case 'quotes': {
        // Batch quotes for multiple symbols
        const symbols = body.symbols || [];
        const results = await Promise.allSettled(
          symbols.map(s => finnhubFetch(`/quote?symbol=${encodeURIComponent(s)}`))
        );
        const out = {};
        symbols.forEach((s, i) => {
          if (results[i].status === 'fulfilled') {
            const q = results[i].value;
            out[s] = { price: q.c || 0, change: q.dp || 0, changeAbs: q.d || 0, high: q.h || 0, low: q.l || 0, open: q.o || 0, prevClose: q.pc || 0, timestamp: q.t || 0 };
          } else {
            out[s] = { price: 0, error: true };
          }
        });
        result = { data: out };
        break;
      }
      case 'market-news': {
        // General market news
        result = await finnhubFetch(`/news?category=${body.category || 'general'}&minId=0`);
        break;
      }
      case 'ipo': {
        // IPO calendar
        const from = body.from || new Date().toISOString().slice(0, 10);
        const to = body.to || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
        result = await finnhubFetch(`/calendar/ipo?from=${from}&to=${to}`);
        break;
      }
      case 'economic': {
        // Economic calendar
        result = await finnhubFetch(`/calendar/economic?from=${body.from || ''}&to=${body.to || ''}`);
        break;
      }
      case 'forex-rates': {
        // Forex rates
        result = await finnhubFetch('/forex/rates?base=USD');
        break;
      }
      case 'indices': {
        // Market indices (US)
        const idxSymbols = ['^GSPC', '^DJI', '^IXIC', '^RUT', '^FTSE', '^GDAXI', '^FCHI', '^N225', '^HSI', '000001.SS'];
        const idxResults = await Promise.allSettled(
          idxSymbols.map(s => finnhubFetch(`/quote?symbol=${encodeURIComponent(s)}`))
        );
        const idxOut = {};
        idxSymbols.forEach((s, i) => {
          if (idxResults[i].status === 'fulfilled') {
            const q = idxResults[i].value;
            idxOut[s] = { price: q.c || 0, change: q.dp || 0, changeAbs: q.d || 0, high: q.h || 0, low: q.l || 0 };
          }
        });
        result = { data: idxOut };
        break;
      }
      default:
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    if (result) {
      cache[ck] = { data: result, ts: Date.now() };
      // Cleanup old cache
      const now = Date.now();
      for (const k in cache) { if (now - cache[k].ts > 60000) delete cache[k]; }
    }

    return { statusCode: 200, headers: H, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
