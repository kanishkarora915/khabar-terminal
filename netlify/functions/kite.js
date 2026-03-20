// Zerodha Kite API Proxy — Secure Token Exchange + Data Proxy
// API secret NEVER exposed to frontend — all handled server-side
const https = require('https');
const crypto = require('crypto');

// Response cache (persists in warm Lambda)
const cache = {};
const CACHE_TTL = { quote: 3000, history: 60000, search: 30000 };

function kiteFetch(path, apiKey, token, method = 'GET', postData = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.kite.trade',
      path,
      method,
      headers: {
        'X-Kite-Version': '3',
        'Authorization': `token ${apiKey}:${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Detect token expiry
          if (parsed.status === 'error' && (parsed.error_type === 'TokenException' || parsed.error_type === 'InputException')) {
            resolve({ _tokenExpired: true, error: parsed.message, error_type: parsed.error_type });
          } else {
            resolve(parsed);
          }
        } catch (e) { resolve({ error: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Kite API timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, api_key, api_secret, access_token, request_token } = body;

    // ─── TOKEN EXCHANGE (most critical) ───
    if (action === 'exchange') {
      if (!api_key || !api_secret || !request_token) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'api_key, api_secret, and request_token required' }) };
      }
      const checksum = sha256(api_key + request_token + api_secret);
      const postData = `api_key=${encodeURIComponent(api_key)}&request_token=${encodeURIComponent(request_token)}&checksum=${checksum}`;

      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.kite.trade', path: '/session/token', method: 'POST',
          headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' }
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ error: data }); } });
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(postData);
        req.end();
      });

      if (result.data?.access_token) {
        return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, access_token: result.data.access_token, user_id: result.data.user_id }) };
      } else {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: result.message || 'Token exchange failed', details: result }) };
      }
    }

    // ─── VALIDATE TOKEN ───
    if (action === 'validate') {
      if (!api_key || !access_token) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing credentials' }) };
      const result = await kiteFetch('/user/profile', api_key, access_token);
      if (result._tokenExpired) return { statusCode: 401, headers: H, body: JSON.stringify({ expired: true, error: result.error }) };
      return { statusCode: 200, headers: H, body: JSON.stringify(result) };
    }

    // ─── DATA PROXYING ───
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
        const instruments = body.instruments || '';
        result = await kiteFetch(`/quote?i=${encodeURIComponent(instruments)}`, api_key, access_token);
        break;
      }
      case 'ltp': {
        const instruments = body.instruments || '';
        result = await kiteFetch(`/quote/ltp?i=${encodeURIComponent(instruments)}`, api_key, access_token);
        break;
      }
      case 'history': {
        const { instrument_token, from, to, interval } = body;
        result = await kiteFetch(`/instruments/historical/${instrument_token}/${interval || 'day'}?from=${from}&to=${to}`, api_key, access_token);
        break;
      }
      case 'search': {
        result = await kiteFetch(`/instruments/NFO`, api_key, access_token);
        break;
      }
      case 'instruments': {
        result = await kiteFetch(`/instruments/${body.exchange || 'NSE'}`, api_key, access_token);
        break;
      }
      case 'holdings': {
        result = await kiteFetch('/portfolio/holdings', api_key, access_token);
        break;
      }
      case 'positions': {
        result = await kiteFetch('/portfolio/positions', api_key, access_token);
        break;
      }
      case 'margins': {
        result = await kiteFetch('/user/margins', api_key, access_token);
        break;
      }
      case 'indices': {
        result = await kiteFetch('/quote?i=NSE%3ANIFTY+50%2CNSE%3ANIFTY+BANK%2CNSE%3ANIFTY+FIN+SERVICE%2CNSE%3ANIFTY+IT%2CNSE%3ANIFTY+MIDCAP+100%2CBSE%3ASENSEX', api_key, access_token);
        break;
      }
      default:
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
    }

    // Detect token expiry
    if (result?._tokenExpired) {
      return { statusCode: 401, headers: H, body: JSON.stringify({ expired: true, error: result.error }) };
    }

    // Cache successful results
    if (result?.data || result?.status === 'success') {
      cache[ck] = { data: result, ts: Date.now() };
      // Clean old cache
      const now = Date.now();
      for (const k in cache) { if (now - cache[k].ts > 300000) delete cache[k]; }
    }

    return { statusCode: 200, headers: H, body: JSON.stringify(result) };

  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
