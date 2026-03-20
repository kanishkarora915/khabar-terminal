// NSE India + Yahoo Finance Proxy — No Auth Required, Lifetime Access
const https = require('https');
const zlib = require('zlib');

// Cookie cache (persists in warm Lambda)
let cookieCache = { cookies: '', ts: 0 };
const COOKIE_TTL = 90000;

// Response cache
const cache = {};
const CACHE_TTL = { quote: 8000, 'option-chain': 12000, indices: 8000, 'index-stocks': 15000, search: 30000, 'market-status': 30000, history: 300000, 'gainers-losers': 15000 };

function httpGet(hostname, path, headers = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br', ...headers } };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        try {
          let body;
          if (enc === 'gzip') body = zlib.gunzipSync(buf).toString();
          else if (enc === 'br') body = zlib.brotliDecompressSync(buf).toString();
          else if (enc === 'deflate') body = zlib.inflateSync(buf).toString();
          else body = buf.toString();
          resolve({ data: JSON.parse(body), setCookies: res.headers['set-cookie'] || [], status: res.statusCode });
        } catch (e) {
          resolve({ data: null, error: `Parse: ${e.message}`, raw: buf.toString().slice(0, 300), status: res.statusCode });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function getNSECookies() {
  if (Date.now() - cookieCache.ts < COOKIE_TTL && cookieCache.cookies) return cookieCache.cookies;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'www.nseindia.com', path: '/', method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br' } }, res => {
      res.on('data', () => {});
      res.on('end', () => {
        const sc = res.headers['set-cookie'] || [];
        const cookies = sc.map(c => c.split(';')[0]).join('; ');
        cookieCache = { cookies, ts: Date.now() };
        resolve(cookies);
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('Cookie timeout')); });
    req.end();
  });
}

async function nseFetch(path) {
  const cookies = await getNSECookies();
  const result = await httpGet('www.nseindia.com', path, { Cookie: cookies, Referer: 'https://www.nseindia.com/' });
  if (!result.data && result.status === 401) {
    cookieCache = { cookies: '', ts: 0 };
    const c2 = await getNSECookies();
    return await httpGet('www.nseindia.com', path, { Cookie: c2, Referer: 'https://www.nseindia.com/' });
  }
  return result;
}

async function yahooFetch(symbol, range, interval) {
  const yfSym = symbol.includes('.') ? symbol : symbol + '.NS';
  const path = `/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${interval || '1d'}&range=${range || '1y'}`;
  return await httpGet('query1.finance.yahoo.com', path, {});
}

exports.handler = async (event) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    // Cache check
    const ck = `${action}:${JSON.stringify(body)}`;
    const cc = cache[ck];
    if (cc && Date.now() - cc.ts < (CACHE_TTL[action] || 10000)) {
      return { statusCode: 200, headers: H, body: JSON.stringify({ ...cc.data, _cached: true }) };
    }

    let result;
    switch (action) {
      case 'quote': {
        result = await nseFetch(`/api/quote-equity?symbol=${encodeURIComponent(body.symbol)}`);
        break;
      }
      case 'option-chain': {
        const t = body.type || 'indices';
        result = await nseFetch(`/api/option-chain-${t}?symbol=${encodeURIComponent(body.symbol)}`);
        break;
      }
      case 'indices': {
        result = await nseFetch('/api/allIndices');
        break;
      }
      case 'index-stocks': {
        result = await nseFetch(`/api/equity-stockIndices?index=${encodeURIComponent(body.index)}`);
        break;
      }
      case 'search': {
        result = await nseFetch(`/api/search/autocomplete?q=${encodeURIComponent(body.query || '')}`);
        break;
      }
      case 'market-status': {
        result = await nseFetch('/api/marketStatus');
        break;
      }
      case 'gainers-losers': {
        result = await nseFetch(`/api/equity-stockIndices?index=${encodeURIComponent(body.index || 'NIFTY 50')}`);
        break;
      }
      case 'history': {
        result = await yahooFetch(body.symbol, body.range || '1y', body.interval || '1d');
        break;
      }
      default:
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    if (result.data) {
      cache[ck] = { data: result.data, ts: Date.now() };
      // Clean old cache
      const now = Date.now();
      for (const k in cache) { if (now - cache[k].ts > 600000) delete cache[k]; }
      return { statusCode: 200, headers: H, body: JSON.stringify(result.data) };
    } else {
      cookieCache = { cookies: '', ts: 0 };
      return { statusCode: 502, headers: H, body: JSON.stringify({ error: result.error || 'Fetch failed', status: result.status }) };
    }
  } catch (e) {
    cookieCache = { cookies: '', ts: 0 };
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
