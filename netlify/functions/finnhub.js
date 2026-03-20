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
        // Market indices via ETF proxies (Finnhub free tier)
        const idxSymbols = ['^GSPC', '^DJI', '^IXIC', '^RUT', '^FTSE', '^GDAXI', '^FCHI', '^N225', '^HSI', '000001.SS'];
        const ETF_PROXY = { '^GSPC': 'SPY', '^DJI': 'DIA', '^IXIC': 'QQQ', '^RUT': 'IWM', '^FTSE': 'EWU', '^GDAXI': 'EWG', '^FCHI': 'EWQ', '^N225': 'EWJ', '^HSI': 'EWH', '000001.SS': 'MCHI' };
        const idxResults = await Promise.allSettled(
          idxSymbols.map(s => finnhubFetch(`/quote?symbol=${encodeURIComponent(ETF_PROXY[s] || s)}`))
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
      case 'global-data': {
        // Complete global market data — replaces Yahoo Finance
        // Maps Yahoo-style symbols to Finnhub-compatible symbols
        const requestedSyms = body.symbols || [];
        const out = {};

        // === Symbol mapping: Yahoo → Finnhub ETF proxy ===
        const YAHOO_TO_FINNHUB = {
          // US Indices → ETFs
          '^GSPC': 'SPY', '^DJI': 'DIA', '^IXIC': 'QQQ', '^RUT': 'IWM',
          // EU Indices → ETFs
          '^FTSE': 'EWU', '^GDAXI': 'EWG', '^FCHI': 'EWQ', '^STOXX50E': 'FEZ',
          // Asia Indices → ETFs
          '^N225': 'EWJ', '^HSI': 'EWH', '000001.SS': 'MCHI', '^STI': 'EWS',
          // Commodities → ETFs
          'GC=F': 'GLD', 'SI=F': 'SLV', 'CL=F': 'USO', 'NG=F': 'UNG', 'HG=F': 'CPER',
          // Bonds → ETFs (price-based, change reflects yield movement)
          '^TNX': 'TLT', '^TYX': 'TLT', '^FVX': 'IEF',
          // Crypto
          'BTC-USD': 'BINANCE:BTCUSDT', 'ETH-USD': 'BINANCE:ETHUSDT',
          // DXY
          'DX-Y.NYB': 'UUP',
        };

        // Forex symbols that need the /forex/rates endpoint
        const FOREX_SYMS = {
          'USDINR=X': { base: 'USD', quote: 'INR' },
          'EURINR=X': { base: 'EUR', quote: 'INR' },
          'GBPINR=X': { base: 'GBP', quote: 'INR' },
          'JPYINR=X': { base: 'JPY', quote: 'INR' },
          'EURUSD=X': { base: 'EUR', quote: 'USD' },
          'GBPUSD=X': { base: 'GBP', quote: 'USD' },
          'USDJPY=X': { base: 'USD', quote: 'JPY' },
          'USDCNY=X': { base: 'USD', quote: 'CNY' },
        };

        // Separate into quote-based and forex-based symbols
        const quoteSyms = [];
        const forexSyms = [];
        const otherSyms = []; // like NIFTY 50 — skip, handled by NSE

        requestedSyms.forEach(sym => {
          if (YAHOO_TO_FINNHUB[sym]) {
            quoteSyms.push(sym);
          } else if (FOREX_SYMS[sym]) {
            forexSyms.push(sym);
          } else {
            otherSyms.push(sym);
          }
        });

        // Fetch ETF/stock quotes in parallel
        const uniqueFinnhubSyms = [...new Set(quoteSyms.map(s => YAHOO_TO_FINNHUB[s]))];
        const [quoteResults, forexResult] = await Promise.all([
          Promise.allSettled(uniqueFinnhubSyms.map(s => finnhubFetch(`/quote?symbol=${encodeURIComponent(s)}`))),
          forexSyms.length > 0 ? finnhubFetch('/forex/rates?base=USD').catch(() => null) : null
        ]);

        // Build finnhub symbol → quote map
        const fhQuotes = {};
        uniqueFinnhubSyms.forEach((s, i) => {
          if (quoteResults[i].status === 'fulfilled') fhQuotes[s] = quoteResults[i].value;
        });

        // Map back to Yahoo symbols
        quoteSyms.forEach(yahoSym => {
          const fhSym = YAHOO_TO_FINNHUB[yahoSym];
          const q = fhQuotes[fhSym];
          if (q && q.c > 0) {
            // For index ETF proxies, multiply by scaling factor to approximate real index value
            const INDEX_SCALE = {
              '^GSPC': 10, '^DJI': 100, '^IXIC': 45, '^RUT': 10,
              '^FTSE': 10, '^GDAXI': 45, '^FCHI': 20, '^STOXX50E': 12,
              '^N225': 100, '^HSI': 350, '000001.SS': 60, '^STI': 80,
            };
            const scale = INDEX_SCALE[yahoSym] || 1;
            out[yahoSym] = {
              price: +(q.c * scale).toFixed(2),
              prev: +(q.pc * scale).toFixed(2),
              change: q.dp || 0,
              high: +(q.h * scale).toFixed(2),
              low: +(q.l * scale).toFixed(2),
              name: yahoSym,
              exchange: 'Finnhub',
              ts: q.t || 0
            };
          } else {
            out[yahoSym] = { price: 0, prev: 0, change: 0, error: true };
          }
        });

        // Forex data
        if (forexResult && forexResult.quote) {
          const rates = forexResult.quote;
          forexSyms.forEach(yahoSym => {
            const fx = FOREX_SYMS[yahoSym];
            if (fx) {
              let price = 0;
              if (fx.base === 'USD') {
                price = rates[fx.quote] || 0;
              } else if (fx.quote === 'USD') {
                price = rates[fx.base] ? (1 / rates[fx.base]) : 0;
              } else {
                // Cross rate: base/quote = (USD/quote) / (USD/base)
                const usdToQuote = rates[fx.quote] || 0;
                const usdToBase = rates[fx.base] || 0;
                price = usdToBase ? (usdToQuote / usdToBase) : 0;
              }
              if (price > 0) {
                out[yahoSym] = {
                  price: +price.toFixed(price > 100 ? 2 : 4),
                  prev: +price.toFixed(price > 100 ? 2 : 4),
                  change: 0, // Forex rates endpoint doesn't provide change
                  name: yahoSym,
                  exchange: 'Finnhub Forex'
                };
              } else {
                out[yahoSym] = { price: 0, prev: 0, change: 0, error: true };
              }
            }
          });
        }

        // Mark other symbols as unavailable
        otherSyms.forEach(s => {
          out[s] = { price: 0, prev: 0, change: 0, error: true, source: 'unsupported' };
        });

        result = { data: out };
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
