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
          if (parsed.status === 'error' && parsed.error_type === 'TokenException') {
            resolve({ _tokenExpired: true, error: parsed.message, error_type: parsed.error_type });
          } else { resolve(parsed); }
        } catch (e) { resolve({ error: data.slice(0, 500) }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Kite API timeout')); });
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
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Instruments CSV timeout')); });
    req.end();
  });
}

function sha256(str) { return crypto.createHash('sha256').update(str).digest('hex'); }

function parseCSV(csv) {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = l.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim().replace(/^"|"$/g, ''); });
    return obj;
  });
}

async function getInstruments(apiKey, token) {
  if (instrumentsCache.data && Date.now() - instrumentsCache.ts < 3600000) return instrumentsCache.data;
  const csv = await kiteFetchRaw('/instruments/NFO', apiKey, token);
  if (!csv || csv.length < 100) throw new Error(`Instruments CSV too small: ${csv.length} bytes. First 200: ${(csv||'').slice(0,200)}`);
  const instruments = parseCSV(csv);
  if (!instruments.length) throw new Error('Parsed 0 instruments from CSV');
  instrumentsCache = { data: instruments, ts: Date.now() };
  return instruments;
}

// Get spot symbol for an index
function getSpotSymbol(symbol) {
  const map = {
    'NIFTY': 'NSE:NIFTY 50',
    'BANKNIFTY': 'NSE:NIFTY BANK',
    'FINNIFTY': 'NSE:NIFTY FIN SERVICE',
    'MIDCPNIFTY': 'NSE:NIFTY MID SELECT',
    'SENSEX': 'BSE:SENSEX'
  };
  return map[symbol] || `NSE:${symbol}`;
}

async function buildOptionChain(apiKey, token, symbol, expiry) {
  const t0 = Date.now();
  const instruments = await getInstruments(apiKey, token);
  const t1 = Date.now();

  // Filter for this symbol's options
  const opts = instruments.filter(i =>
    i.name === symbol &&
    (i.instrument_type === 'CE' || i.instrument_type === 'PE') &&
    i.segment === 'NFO-OPT'
  );

  if (!opts.length) {
    // Debug: check what names exist
    const names = [...new Set(instruments.filter(i => i.segment === 'NFO-OPT').map(i => i.name))].sort();
    throw new Error(`No options for "${symbol}". Available index names: ${names.slice(0, 20).join(', ')}`);
  }

  // Get unique expiry dates and sort
  const expiries = [...new Set(opts.map(o => o.expiry))].sort((a, b) => new Date(a) - new Date(b));

  // Handle expiry param in various formats
  let selectedExpiry = expiries[0];
  if (expiry) {
    if (expiries.includes(expiry)) {
      selectedExpiry = expiry;
    } else {
      const parsed = new Date(expiry);
      if (!isNaN(parsed)) {
        const match = expiries.find(e => new Date(e).toDateString() === parsed.toDateString());
        if (match) selectedExpiry = match;
      }
    }
  }
  const expiryOpts = opts.filter(o => o.expiry === selectedExpiry);
  if (!expiryOpts.length) throw new Error(`No options for expiry ${selectedExpiry}`);

  // Get spot price
  const spotSym = getSpotSymbol(symbol);
  const spotQuote = await kiteFetch(`/quote/ltp?i=${encodeURIComponent(spotSym)}`, apiKey, token);
  const spot = spotQuote?.data?.[spotSym]?.last_price || 0;
  const t2 = Date.now();

  // Get strikes near ATM (±15 strikes)
  const strikes = [...new Set(expiryOpts.map(o => parseFloat(o.strike)))].sort((a, b) => a - b);
  let nearStrikes = strikes;
  if (spot > 0 && strikes.length > 30) {
    const atmIdx = strikes.reduce((best, s, i) => Math.abs(s - spot) < Math.abs(strikes[best] - spot) ? i : best, 0);
    const start = Math.max(0, atmIdx - 15);
    const end = Math.min(strikes.length, atmIdx + 16);
    nearStrikes = strikes.slice(start, end);
  }

  // Filter instruments to near strikes only
  const nearOpts = expiryOpts.filter(o => nearStrikes.includes(parseFloat(o.strike)));

  // Fetch quotes in batches — Kite API accepts multiple i= params
  const allQuotes = {};
  const batchSize = 30;
  for (let i = 0; i < nearOpts.length; i += batchSize) {
    const batch = nearOpts.slice(i, i + batchSize);
    const queryStr = batch.map(o => `i=NFO:${o.tradingsymbol}`).join('&');
    try {
      const qr = await kiteFetch(`/quote?${queryStr}`, apiKey, token);
      if (qr?.data) Object.assign(allQuotes, qr.data);
    } catch (e) { /* continue */ }
  }
  const t3 = Date.now();

  // Format expiry for NSE-compatible display
  function fmtExpiry(e) {
    const d = new Date(e + 'T00:00:00Z');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${String(d.getUTCDate()).padStart(2,'0')}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  }
  const fmtSelectedExpiry = fmtExpiry(selectedExpiry);

  // Build option chain
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
        openInterest: ceQuote.oi || 0,
        changeinOpenInterest: (ceQuote.oi || 0) - (ceQuote.oi_day_low || ceQuote.oi || 0),
        pchangeinOpenInterest: 0,
        totalTradedVolume: ceQuote.volume || 0,
        impliedVolatility: 0,
        lastPrice: ceQuote.last_price || 0,
        change: ceQuote.net_change || 0,
        pChange: ceQuote.ohlc?.close ? ((ceQuote.last_price - ceQuote.ohlc.close) / ceQuote.ohlc.close * 100) : 0,
        totalBuyQuantity: ceQuote.buy_quantity || 0,
        totalSellQuantity: ceQuote.sell_quantity || 0,
        bidQty: ceQuote.depth?.buy?.[0]?.quantity || 0,
        bidprice: ceQuote.depth?.buy?.[0]?.price || 0,
        askQty: ceQuote.depth?.sell?.[0]?.quantity || 0,
        askPrice: ceQuote.depth?.sell?.[0]?.price || 0,
      };
    }

    if (peQuote) {
      row.PE = {
        strikePrice: strike, expiryDate: fmtSelectedExpiry, underlying: symbol, underlyingValue: spot,
        openInterest: peQuote.oi || 0,
        changeinOpenInterest: (peQuote.oi || 0) - (peQuote.oi_day_low || peQuote.oi || 0),
        pchangeinOpenInterest: 0,
        totalTradedVolume: peQuote.volume || 0,
        impliedVolatility: 0,
        lastPrice: peQuote.last_price || 0,
        change: peQuote.net_change || 0,
        pChange: peQuote.ohlc?.close ? ((peQuote.last_price - peQuote.ohlc.close) / peQuote.ohlc.close * 100) : 0,
        totalBuyQuantity: peQuote.buy_quantity || 0,
        totalSellQuantity: peQuote.sell_quantity || 0,
        bidQty: peQuote.depth?.buy?.[0]?.quantity || 0,
        bidprice: peQuote.depth?.buy?.[0]?.price || 0,
        askQty: peQuote.depth?.sell?.[0]?.quantity || 0,
        askPrice: peQuote.depth?.sell?.[0]?.price || 0,
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
    },
    _debug: {
      timings: { instruments: t1 - t0, spot: t2 - t1, quotes: t3 - t2, total: Date.now() - t0 },
      counts: { totalInstruments: instruments.length, symbolOpts: opts.length, expiryOpts: expiryOpts.length, nearOpts: nearOpts.length, quotesReceived: Object.keys(allQuotes).length, chainRows: chainData.length },
      spot, selectedExpiry, fmtSelectedExpiry
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

    // DEBUG endpoint — test option chain step by step
    if (action === 'debug-oc') {
      if (!api_key || !access_token) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Need api_key + access_token' }) };
      const debug = {};
      try {
        // Step 1: Test API connection
        const profile = await kiteFetch('/user/profile', api_key, access_token);
        debug.step1_profile = profile?.data ? 'OK: ' + profile.data.user_name : 'FAILED: ' + JSON.stringify(profile).slice(0, 200);

        // Step 2: Fetch instruments
        const t0 = Date.now();
        const csv = await kiteFetchRaw('/instruments/NFO', api_key, access_token);
        debug.step2_csv = { bytes: csv.length, timeMs: Date.now() - t0, first200: csv.slice(0, 200) };

        // Step 3: Parse
        const instruments = parseCSV(csv);
        debug.step3_parsed = { count: instruments.length, sample: instruments[0] };

        // Step 4: Filter for NIFTY
        const niftyOpts = instruments.filter(i => i.name === 'NIFTY' && (i.instrument_type === 'CE' || i.instrument_type === 'PE') && i.segment === 'NFO-OPT');
        debug.step4_nifty = { count: niftyOpts.length, sample: niftyOpts[0], expiries: [...new Set(niftyOpts.map(o => o.expiry))].sort().slice(0, 5) };

        // Step 5: Available index names
        const indexNames = [...new Set(instruments.filter(i => i.segment === 'NFO-OPT').map(i => i.name))].sort();
        debug.step5_indexNames = indexNames.slice(0, 30);

        // Step 6: Test spot quote
        const spotQuote = await kiteFetch('/quote/ltp?i=NSE:NIFTY%2050', api_key, access_token);
        debug.step6_spot = spotQuote;

        // Step 7: Test a single option quote
        if (niftyOpts.length) {
          const testOpt = niftyOpts[0];
          const testQuote = await kiteFetch(`/quote?i=NFO:${testOpt.tradingsymbol}`, api_key, access_token);
          debug.step7_optQuote = { symbol: testOpt.tradingsymbol, result: testQuote?.data ? 'OK' : JSON.stringify(testQuote).slice(0, 300) };
        }
      } catch (e) {
        debug.error = e.message;
      }
      return { statusCode: 200, headers: H, body: JSON.stringify(debug) };
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
      case 'quote': {
        // Support both single and multiple instruments
        const instruments = body.instruments || '';
        const syms = instruments.split(',').map(s => s.trim()).filter(Boolean);
        const queryStr = syms.map(s => `i=${encodeURIComponent(s)}`).join('&');
        result = await kiteFetch(`/quote?${queryStr}`, api_key, access_token);
        break;
      }
      case 'ltp': {
        const instruments = body.instruments || '';
        const syms = instruments.split(',').map(s => s.trim()).filter(Boolean);
        const queryStr = syms.map(s => `i=${encodeURIComponent(s)}`).join('&');
        result = await kiteFetch(`/quote/ltp?${queryStr}`, api_key, access_token);
        break;
      }
      case 'history': {
        const { instrument_token, from, to, interval } = body;
        result = await kiteFetch(`/instruments/historical/${instrument_token}/${interval || 'day'}?from=${from}&to=${to}`, api_key, access_token);
        break;
      }
      case 'indices':
        result = await kiteFetch('/quote?i=NSE:NIFTY%2050&i=NSE:NIFTY%20BANK&i=NSE:NIFTY%20FIN%20SERVICE&i=NSE:NIFTY%20IT&i=NSE:NIFTY%20MIDCAP%20100&i=BSE:SENSEX', api_key, access_token);
        break;
      case 'option-chain': {
        try {
          const ocData = await buildOptionChain(api_key, access_token, body.symbol, body.expiry);
          if (ocData && ocData.records.data.length > 0) {
            cache[ck] = { data: ocData, ts: Date.now() };
            return { statusCode: 200, headers: H, body: JSON.stringify(ocData) };
          }
          return { statusCode: 200, headers: H, body: JSON.stringify({ error: `No option data for ${body.symbol}. Quotes may be empty outside market hours.`, _debug: ocData?._debug }) };
        } catch (ocErr) {
          return { statusCode: 200, headers: H, body: JSON.stringify({ error: `OC build failed: ${ocErr.message}` }) };
        }
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
