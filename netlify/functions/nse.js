// NSE India + Yahoo Finance Proxy
const https = require('https');
const zlib = require('zlib');

let cookieCache = { cookies: '', ts: 0 };
const COOKIE_TTL = 60000;
const cache = {};
const CACHE_TTL = { quote: 8000, 'option-chain': 10000, indices: 8000, 'index-stocks': 15000, search: 30000, history: 300000 };

function httpGet(hostname, path, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        ...headers
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        try {
          let body;
          if (enc === 'gzip') body = zlib.gunzipSync(buf).toString();
          else if (enc === 'deflate') body = zlib.inflateSync(buf).toString();
          else body = buf.toString();
          try {
            resolve({ data: JSON.parse(body), status: res.statusCode, cookies: res.headers['set-cookie'] || [] });
          } catch(e) {
            resolve({ data: null, error: 'JSON parse failed', rawLen: body.length, status: res.statusCode, snippet: body.slice(0, 200) });
          }
        } catch (e) {
          // Try raw
          try {
            resolve({ data: JSON.parse(buf.toString()), status: res.statusCode });
          } catch(e2) {
            resolve({ data: null, error: 'Decode failed: ' + e.message, status: res.statusCode });
          }
        }
      });
    });
    req.on('error', e => reject(e));
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function getNSECookies() {
  if (Date.now() - cookieCache.ts < COOKIE_TTL && cookieCache.cookies) return cookieCache.cookies;

  // Try multiple pages for cookies
  const pages = ['/', '/market-data/live-equity-market', '/option-chain'];

  for (const page of pages) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'www.nseindia.com', path: page, method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Upgrade-Insecure-Requests': '1',
          }
        }, res => {
          let data = [];
          res.on('data', c => data.push(c));
          res.on('end', () => {
            const sc = res.headers['set-cookie'] || [];
            const cookies = sc.map(c => c.split(';')[0]).join('; ');
            resolve({ cookies, status: res.statusCode });
          });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Cookie timeout')); });
        req.end();
      });

      if (result.cookies && result.status < 400) {
        cookieCache = { cookies: result.cookies, ts: Date.now() };
        return result.cookies;
      }
    } catch (e) {
      continue;
    }
  }
  return '';
}

async function nseFetch(path) {
  // Try up to 3 times with fresh cookies each time on failure
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) cookieCache = { cookies: '', ts: 0 };
      const cookies = await getNSECookies();

      const result = await httpGet('www.nseindia.com', path, {
        'Cookie': cookies,
        'Referer': 'https://www.nseindia.com/option-chain',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      });

      if (result.data) return result;
      if (result.status === 401 || result.status === 403) continue;
      return result;
    } catch (e) {
      if (attempt === 2) return { data: null, error: e.message, status: 0 };
    }
  }
  return { data: null, error: 'All retries failed', status: 0 };
}

async function yahooFetch(symbol, range, interval) {
  // Map Indian indices to correct Yahoo Finance symbols
  const YAHOO_INDEX_MAP = {
    'NIFTY 50': '^NSEI', 'NIFTY': '^NSEI', 'NIFTY50': '^NSEI',
    'NIFTY BANK': '^NSEBANK', 'BANKNIFTY': '^NSEBANK', 'BANK NIFTY': '^NSEBANK',
    'SENSEX': '^BSESN', 'BSE SENSEX': '^BSESN',
    'NIFTY IT': '^CNXIT', 'NIFTY FIN SERVICE': '^CNXFIN',
    'NIFTY MIDCAP 100': '^CNXMDCP', 'FINNIFTY': '^CNXFIN',
    'NIFTY AUTO': '^CNXAUTO', 'NIFTY PHARMA': '^CNXPHARMA',
    'NIFTY METAL': '^CNXMETAL', 'NIFTY REALTY': '^CNXREALTY',
    'NIFTY ENERGY': '^CNXENERGY', 'NIFTY FMCG': '^CNXFMCG',
    'NIFTY PSU BANK': '^CNXPSUBANK', 'NIFTY MEDIA': '^CNXMEDIA',
  };
  const upper = symbol.toUpperCase();
  const yfSym = YAHOO_INDEX_MAP[upper] || (symbol.includes('.') ? symbol : symbol + '.NS');
  const path = `/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${interval || '1d'}&range=${range || '1y'}`;

  // Try primary Yahoo endpoint, fallback to secondary
  let result = await httpGet('query1.finance.yahoo.com', path, {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  if (!result.data?.chart?.result) {
    result = await httpGet('query2.finance.yahoo.com', path, {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
  }
  return result;
}

exports.handler = async (event) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    const ck = `${action}:${JSON.stringify(body)}`;
    const cc = cache[ck];
    if (cc && Date.now() - cc.ts < (CACHE_TTL[action] || 10000)) {
      return { statusCode: 200, headers: H, body: JSON.stringify({ ...cc.data, _cached: true }) };
    }

    let result;
    switch (action) {
      case 'quote':
        result = await nseFetch(`/api/quote-equity?symbol=${encodeURIComponent(body.symbol)}`);
        break;
      case 'option-chain':
        result = await nseFetch(`/api/option-chain-${body.type || 'indices'}?symbol=${encodeURIComponent(body.symbol)}`);
        break;
      case 'indices':
        result = await nseFetch('/api/allIndices');
        break;
      case 'index-stocks':
        result = await nseFetch(`/api/equity-stockIndices?index=${encodeURIComponent(body.index)}`);
        break;
      case 'search':
        result = await nseFetch(`/api/search/autocomplete?q=${encodeURIComponent(body.query || '')}`);
        break;
      case 'market-status':
        result = await nseFetch('/api/marketStatus');
        break;
      case 'fii-dii':
        // Real FII/DII data from NSE
        result = await nseFetch('/api/fiidiiTradeReact');
        break;
      case 'history':
        result = await yahooFetch(body.symbol, body.range || '1y', body.interval || '1d');
        break;
      case 'global-data': {
        // Batch fetch multiple Yahoo Finance symbols in parallel
        const symbols = body.symbols || [];
        const range = body.range || '1d';
        const interval = body.interval || '5m';
        const results = await Promise.allSettled(
          symbols.map(sym => yahooFetch(sym, range, interval))
        );
        const out = {};
        symbols.forEach((sym, i) => {
          const r = results[i];
          if (r.status === 'fulfilled' && r.value?.data?.chart?.result?.[0]) {
            const c = r.value.data.chart.result[0];
            const meta = c.meta || {};
            const quotes = c.indicators?.quote?.[0] || {};
            const closes = quotes.close || [];
            const prev = meta.chartPreviousClose || meta.previousClose || 0;
            const last = meta.regularMarketPrice || closes.filter(v => v != null).pop() || 0;
            const chg = prev ? ((last - prev) / prev * 100) : 0;
            out[sym] = { price: last, prev, change: chg, high: meta.regularMarketDayHigh || 0, low: meta.regularMarketDayLow || 0, currency: meta.currency || '', exchange: meta.exchangeName || '', name: meta.shortName || sym, ts: meta.regularMarketTime || 0 };
          } else {
            out[sym] = { price: 0, prev: 0, change: 0, error: true };
          }
        });
        result = { data: out };
        break;
      }
      case 'test':
        // Debug endpoint
        const cookies = await getNSECookies();
        return { statusCode: 200, headers: H, body: JSON.stringify({ cookieLen: cookies.length, hasCookies: !!cookies, cookies: cookies.slice(0, 100) + '...' }) };
      default:
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    if (result.data) {
      cache[ck] = { data: result.data, ts: Date.now() };
      const now = Date.now();
      for (const k in cache) { if (now - cache[k].ts > 600000) delete cache[k]; }
      return { statusCode: 200, headers: H, body: JSON.stringify(result.data) };
    } else {
      return { statusCode: 502, headers: H, body: JSON.stringify({ error: result.error || 'NSE fetch failed', status: result.status, snippet: result.snippet || '' }) };
    }
  } catch (e) {
    cookieCache = { cookies: '', ts: 0 };
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
