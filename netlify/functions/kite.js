// Zerodha Kite API Proxy — Secure Token Exchange + Data + Option Chain Builder
const https = require('https');
const crypto = require('crypto');

const cache = {};
const CACHE_TTL = { quote: 3000, history: 60000, search: 30000, 'option-chain': 8000, instruments: 3600000 };
let instrumentsCache = { data: null, ts: 0 };

function kiteFetch(path, apiKey, token, method = 'GET', postData = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.kite.trade', path, method,
      headers: { 'X-Kite-Version': '3', 'Authorization': `token ${apiKey}:${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status === 'error' && (parsed.error_type === 'TokenException' || parsed.error_type === 'InputException')) {
            resolve({ _tokenExpired: true, error: parsed.message, error_type: parsed.error_type });
          } else { resolve(parsed); }
        } catch (e) { resolve({ error: data.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Kite timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// Fetch raw text (for instruments CSV)
function kiteFetchRaw(path, apiKey, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.kite.trade', path, method: 'GET',
      headers: { 'X-Kite-Version': '3', 'Authorization': `token ${apiKey}:${token}` }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function sha256(str) { return crypto.createHash('sha256').update(str).digest('hex'); }

function parseCSV(csv) {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = l.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });
}

async function getInstruments(apiKey, token) {
  // Cache instruments for 1 hour (they rarely change)
  if (instrumentsCache.data && Date.now() - instrumentsCache.ts < 3600000) return instrumentsCache.data;
  const csv = await kiteFetchRaw('/instruments/NFO', apiKey, token);
  const instruments = parseCSV(csv);
  instrumentsCache = { data: instruments, ts: Date.now() };
  return instruments;
}

async function buildOptionChain(apiKey, token, symbol, expiry) {
  const instruments = await getInstruments(apiKey, token);

  // Map symbol names: NIFTY -> NIFTY, BANKNIFTY -> BANKNIFTY
  const opts = instruments.filter(i =>
    i.name === symbol &&
    (i.instrument_type === 'CE' || i.instrument_type === 'PE') &&
    i.segment === 'NFO-OPT'
  );

  if (!opts.length) return null;

  // Get unique expiry dates and sort
  const expiries = [...new Set(opts.map(o => o.expiry))].sort((a, b) => new Date(a) - new Date(b));

  // Handle expiry param in various formats (e.g., "27-Mar-2026" from frontend or "2026-03-27" from CSV)
  let selectedExpiry = expiries[0];
  if (expiry) {
    // Try direct match first
    if (expiries.includes(expiry)) {
      selectedExpiry = expiry;
    } else {
      // Try parsing the formatted date and matching
      const parsed = new Date(expiry);
      if (!isNaN(parsed)) {
        const match = expiries.find(e => new Date(e).toDateString() === parsed.toDateString());
        if (match) selectedExpiry = match;
      }
    }
  }
  const expiryOpts = opts.filter(o => o.expiry === selectedExpiry);

  if (!expiryOpts.length) return null;

  // Get spot price first
  const spotSym = symbol === 'NIFTY' ? 'NSE:NIFTY 50' : symbol === 'BANKNIFTY' ? 'NSE:NIFTY BANK' : symbol === 'FINNIFTY' ? 'NSE:NIFTY FIN SERVICE' : `NSE:${symbol}`;
  const spotQuote = await kiteFetch(`/quote/ltp?i=${encodeURIComponent(spotSym)}`, apiKey, token);
  const spot = spotQuote?.data?.[spotSym]?.last_price || 0;

  // Get strikes near ATM (±20 strikes to reduce API calls)
  const strikes = [...new Set(expiryOpts.map(o => parseFloat(o.strike)))].sort((a, b) => a - b);
  let nearStrikes = strikes;
  if (spot > 0 && strikes.length > 40) {
    const atmIdx = strikes.reduce((best, s, i) => Math.abs(s - spot) < Math.abs(strikes[best] - spot) ? i : best, 0);
    const start = Math.max(0, atmIdx - 20);
    const end = Math.min(strikes.length, atmIdx + 21);
    nearStrikes = strikes.slice(start, end);
  }

  // Filter instruments to near strikes only
  const nearOpts = expiryOpts.filter(o => nearStrikes.includes(parseFloat(o.strike)));

  // Fetch quotes in batches (max ~200 per call to be safe)
  const allQuotes = {};
  const batchSize = 200;
  for (let i = 0; i < nearOpts.length; i += batchSize) {
    const batch = nearOpts.slice(i, i + batchSize);
    const symbols = batch.map(o => `NFO:${o.tradingsymbol}`).join(',');
    try {
      const qr = await kiteFetch(`/quote?i=${encodeURIComponent(symbols)}`, apiKey, token);
      if (qr?.data) Object.assign(allQuotes, qr.data);
    } catch (e) { /* continue with partial data */ }
  }

  // Format expiry for NSE-compatible display (e.g., "27-Mar-2026")
  function fmtExpiry(e) { const d = new Date(e); return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-'); }
  const fmtSelectedExpiry = fmtExpiry(selectedExpiry);

  // Build option chain in NSE-compatible format
  const chainData = [];
  nearStrikes.forEach(strike => {
    const ceInst = nearOpts.find(o => parseFloat(o.strike) === strike && o.instrument_type === 'CE');
    const peInst = nearOpts.find(o => parseFloat(o.strike) === strike && o.instrument_type === 'PE');

    const ceQuote = ceInst ? allQuotes[`NFO:${ceInst.tradingsymbol}`] : null;
    const peQuote = peInst ? allQuotes[`NFO:${peInst.tradingsymbol}`] : null;

    const row = { strikePrice: strike, expiryDate: fmtSelectedExpiry };

    if (ceQuote) {
      row.CE = {
        strikePrice: strike, expiryDate: fmtSelectedExpiry, underlying: symbol, underlyingValue: spot,
        openInterest: ceQuote.oi || 0, changeinOpenInterest: ceQuote.oi_day_high ? ceQuote.oi - (ceQuote.oi_day_low || 0) : 0,
        pchangeinOpenInterest: 0, totalTradedVolume: ceQuote.volume || 0,
        impliedVolatility: 0, // Kite doesn't provide IV directly
        lastPrice: ceQuote.last_price || 0, change: ceQuote.net_change || 0,
        pChange: ceQuote.ohlc?.close ? ((ceQuote.last_price - ceQuote.ohlc.close) / ceQuote.ohlc.close * 100) : 0,
        totalBuyQuantity: ceQuote.buy_quantity || 0, totalSellQuantity: ceQuote.sell_quantity || 0,
        bidQty: ceQuote.depth?.buy?.[0]?.quantity || 0, bidprice: ceQuote.depth?.buy?.[0]?.price || 0,
        askQty: ceQuote.depth?.sell?.[0]?.quantity || 0, askPrice: ceQuote.depth?.sell?.[0]?.price || 0,
      };
    }

    if (peQuote) {
      row.PE = {
        strikePrice: strike, expiryDate: fmtSelectedExpiry, underlying: symbol, underlyingValue: spot,
        openInterest: peQuote.oi || 0, changeinOpenInterest: peQuote.oi_day_high ? peQuote.oi - (peQuote.oi_day_low || 0) : 0,
        pchangeinOpenInterest: 0, totalTradedVolume: peQuote.volume || 0,
        impliedVolatility: 0,
        lastPrice: peQuote.last_price || 0, change: peQuote.net_change || 0,
        pChange: peQuote.ohlc?.close ? ((peQuote.last_price - peQuote.ohlc.close) / peQuote.ohlc.close * 100) : 0,
        totalBuyQuantity: peQuote.buy_quantity || 0, totalSellQuantity: peQuote.sell_quantity || 0,
        bidQty: peQuote.depth?.buy?.[0]?.quantity || 0, bidprice: peQuote.depth?.buy?.[0]?.price || 0,
        askQty: peQuote.depth?.sell?.[0]?.quantity || 0, askPrice: peQuote.depth?.sell?.[0]?.price || 0,
      };
    }

    if (row.CE || row.PE) chainData.push(row);
  });

  // Calculate totals
  let totCallOI = 0, totPutOI = 0, totCallVol = 0, totPutVol = 0;
  chainData.forEach(r => {
    totCallOI += r.CE?.openInterest || 0;
    totPutOI += r.PE?.openInterest || 0;
    totCallVol += r.CE?.totalTradedVolume || 0;
    totPutVol += r.PE?.totalTradedVolume || 0;
  });

  // Return in NSE-compatible format
  return {
    records: {
      expiryDates: expiries.map(e => fmtExpiry(e)),
      data: chainData,
      strikePrices: nearStrikes,
    },
    filtered: {
      data: chainData,
      CE: { totOI: totCallOI, totVol: totCallVol },
      PE: { totOI: totPutOI, totVol: totPutVol },
    }
  };
}

exports.handler = async (event) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, api_key, api_secret, access_token, request_token } = body;

    // TOKEN EXCHANGE
    if (action === 'exchange') {
      if (!api_key || !api_secret || !request_token) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing params' }) };
      const checksum = sha256(api_key + request_token + api_secret);
      const postData = `api_key=${encodeURIComponent(api_key)}&request_token=${encodeURIComponent(request_token)}&checksum=${checksum}`;
      const result = await new Promise((resolve, reject) => {
        const req = https.request({ hostname: 'api.kite.trade', path: '/session/token', method: 'POST', headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ error: d }); } });
        });
        req.on('error', reject); req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); }); req.write(postData); req.end();
      });
      if (result.data?.access_token) return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, access_token: result.data.access_token, user_id: result.data.user_id }) };
      return { statusCode: 400, headers: H, body: JSON.stringify({ error: result.message || 'Exchange failed' }) };
    }

    if (action === 'validate') {
      if (!api_key || !access_token) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing credentials' }) };
      const result = await kiteFetch('/user/profile', api_key, access_token);
      if (result._tokenExpired) return { statusCode: 401, headers: H, body: JSON.stringify({ expired: true }) };
      return { statusCode: 200, headers: H, body: JSON.stringify(result) };
    }

    if (!api_key || !access_token) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'api_key and access_token required' }) };

    // Cache check
    const ck = `${action}:${JSON.stringify(body)}`;
    const cc = cache[ck];
    if (cc && Date.now() - cc.ts < (CACHE_TTL[action] || 5000)) {
      return { statusCode: 200, headers: H, body: JSON.stringify({ ...cc.data, _cached: true }) };
    }

    let result;
    switch (action) {
      case 'quote':
        result = await kiteFetch(`/quote?i=${encodeURIComponent(body.instruments || '')}`, api_key, access_token);
        break;
      case 'ltp':
        result = await kiteFetch(`/quote/ltp?i=${encodeURIComponent(body.instruments || '')}`, api_key, access_token);
        break;
      case 'history': {
        const { instrument_token, from, to, interval } = body;
        result = await kiteFetch(`/instruments/historical/${instrument_token}/${interval || 'day'}?from=${from}&to=${to}`, api_key, access_token);
        break;
      }
      case 'indices':
        result = await kiteFetch('/quote?i=NSE%3ANIFTY+50%2CNSE%3ANIFTY+BANK%2CNSE%3ANIFTY+FIN+SERVICE%2CNSE%3ANIFTY+IT%2CNSE%3ANIFTY+MIDCAP+100%2CBSE%3ASENSEX', api_key, access_token);
        break;
      case 'option-chain': {
        // BUILD OPTION CHAIN FROM KITE DATA
        const ocData = await buildOptionChain(api_key, access_token, body.symbol, body.expiry);
        if (ocData) {
          cache[ck] = { data: ocData, ts: Date.now() };
          return { statusCode: 200, headers: H, body: JSON.stringify(ocData) };
        }
        return { statusCode: 404, headers: H, body: JSON.stringify({ error: `No options found for ${body.symbol}` }) };
      }
      case 'holdings':
        result = await kiteFetch('/portfolio/holdings', api_key, access_token);
        break;
      case 'positions':
        result = await kiteFetch('/portfolio/positions', api_key, access_token);
        break;
      case 'margins':
        result = await kiteFetch('/user/margins', api_key, access_token);
        break;
      default:
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
    }

    if (result?._tokenExpired) return { statusCode: 401, headers: H, body: JSON.stringify({ expired: true, error: result.error }) };

    if (result?.data || result?.status === 'success') {
      cache[ck] = { data: result, ts: Date.now() };
      const now = Date.now();
      for (const k in cache) { if (now - cache[k].ts > 300000) delete cache[k]; }
    }

    return { statusCode: 200, headers: H, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
