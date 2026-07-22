// ═══════════════════════════════════════════════════════════════════════════════
// KHABAR — Render server
//
// One process that (a) serves the static app, (b) reuses the existing Netlify
// function handlers unchanged, and (c) adds a persistent-disk store for the
// training data that used to live only in the browser.
//
// The frontend keeps calling /.netlify/functions/NAME, so index.html needs no
// changes and the same file still deploys to Netlify — this migration is
// additive, not a rewrite.
// ═══════════════════════════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8181;
const ROOT = __dirname;
// Render mounts the persistent disk here; falls back to a local dir for dev.
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, '.data');

// ─── The five existing Netlify function handlers, reused as-is ──────────────────
const FUNCTIONS = {
  auth:    require('./netlify/functions/auth.js').handler,
  finnhub: require('./netlify/functions/finnhub.js').handler,
  kite:    require('./netlify/functions/kite.js').handler,
  news:    require('./netlify/functions/news.js').handler,
  nse:     require('./netlify/functions/nse.js').handler,
};

// ─── Persistent store ───────────────────────────────────────────────────────────
// One JSON file per namespace on the mounted disk. Deliberately simple — this is
// key/value config and append-mostly journals, not a query workload.
const STORE_NS = new Set([
  'signal_journal', 'iv_history', 'vol_baseline', 'events', 'tuned_weights', 'risk_cfg', 'paper_book'
]);

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

// ─── Continuous OI snapshot cron ────────────────────────────────────────────────
// The manipulation engines (wall / trap / stealth) read a rolling OI time-series.
// In the browser that only builds while a BRAIN tab is open. Here the server keeps
// building it every 30s during market hours from the user's own token, so the
// history is continuous and survives a page close. The client seeds its window
// from /oi-history on load.
const OI = {
  token: null, apiKey: null,               // supplied by the client after login
  hist: {},                                // index -> [{ts, pcr, maxPain, strikes:[…]}]
  MAX: 240,                                // 30s × 240 = 2h rolling
  tokFile: path.join(DATA_DIR, 'kite_token.json'),
  histFile: path.join(DATA_DIR, 'oi_history.json'),

  load() {
    try { const t = JSON.parse(fs.readFileSync(this.tokFile, 'utf8')); this.token = t.access_token; this.apiKey = t.api_key; } catch (e) {}
    try { this.hist = JSON.parse(fs.readFileSync(this.histFile, 'utf8')) || {}; } catch (e) { this.hist = {}; }
  },
  saveTok() { try { ensureDataDir(); fs.writeFileSync(this.tokFile, JSON.stringify({ access_token: this.token, api_key: this.apiKey })); } catch (e) {} },
  saveHist() { try { ensureDataDir(); fs.writeFileSync(this.histFile, JSON.stringify(this.hist)); } catch (e) {} },

  // IST market-hours check (server runs UTC on Render)
  marketOpen() {
    const nowUTC = Date.now();
    const ist = new Date(nowUTC + 5.5 * 3600 * 1000);
    const day = ist.getUTCDay();                    // 0 Sun … 6 Sat
    if (day === 0 || day === 6) return false;
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
  },

  async tick() {
    if (!this.token || !this.apiKey || !this.marketOpen()) return;
    for (const index of ['NIFTY', 'BANKNIFTY']) {
      try {
        const out = await FUNCTIONS.kite({ httpMethod: 'POST', body: JSON.stringify({
          action: 'option-chain', symbol: index, api_key: this.apiKey, access_token: this.token
        }) });
        const data = JSON.parse(out.body || '{}');
        const rows = data?.records?.data;
        if (!rows?.length) continue;
        let totalCE = 0, totalPE = 0;
        rows.forEach(r => { totalCE += r.CE?.openInterest || 0; totalPE += r.PE?.openInterest || 0; });
        // max pain
        let maxPain = rows[0]?.strikePrice || 0, minPain = Infinity;
        rows.forEach(t => { const K = t.strikePrice; let pain = 0;
          rows.forEach(s => { if (K > s.strikePrice) pain += (s.CE?.openInterest||0)*(K-s.strikePrice);
                              if (K < s.strikePrice) pain += (s.PE?.openInterest||0)*(s.strikePrice-K); });
          if (pain < minPain) { minPain = pain; maxPain = K; } });
        const snap = { ts: Date.now(), pcr: totalCE ? totalPE/totalCE : 0, maxPain,
          strikes: rows.map(r => ({ strike: r.strikePrice, ceOI: r.CE?.openInterest||0, peOI: r.PE?.openInterest||0,
                                    ceIV: r.CE?.impliedVolatility||0, peIV: r.PE?.impliedVolatility||0 })) };
        const arr = this.hist[index] = this.hist[index] || [];
        arr.push(snap);
        if (arr.length > this.MAX) this.hist[index] = arr.slice(-this.MAX);
      } catch (e) { /* skip this index this tick */ }
    }
    this.saveHist();
  }
};
function storePath(ns) { return path.join(DATA_DIR, ns + '.json'); }

function storeGet(ns) {
  try {
    const raw = fs.readFileSync(storePath(ns), 'utf8');
    return JSON.parse(raw);
  } catch (e) { return null; }
}
function storePut(ns, value) {
  ensureDataDir();
  const tmp = storePath(ns) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, storePath(ns));   // atomic replace so a crash can't truncate
}

// ─── Static file serving ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // never let a request climb out of the app root
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) {
      // SPA fallback — any unknown non-file path returns the app shell
      fs.readFile(path.join(ROOT, 'index.html'), (e2, shell) => {
        if (e2) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(shell);
      });
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // HTML/SW always fresh, hashed assets cacheable
    if (ext === '.html' || rel === '/sw.js') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers).end(buf);
  });
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }

  // ── Function routes: /.netlify/functions/NAME (compat with the deployed app) ──
  const fnMatch = url.match(/^\/\.netlify\/functions\/([a-z]+)/);
  if (fnMatch) {
    const fn = FUNCTIONS[fnMatch[1]];
    if (!fn) { res.writeHead(404, CORS).end(JSON.stringify({ error: 'no such function' })); return; }
    const body = await readBody(req);
    try {
      const out = await fn({ httpMethod: req.method, body, headers: req.headers });
      res.writeHead(out.statusCode || 200, { ...CORS, ...(out.headers || {}) }).end(out.body || '');
    } catch (e) {
      res.writeHead(500, CORS).end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Zerodha login callback lands here if the Kite app's redirect URL is set
  //    to /api/callback or /callback. Serve the app so it can read the
  //    request_token from the query string, rather than routing to a function. ──
  if (url.startsWith('/api/callback') || url.startsWith('/callback')) {
    serveStatic(req, res, '/index.html');
    return;
  }

  // ── /api/* → nse (same redirect Netlify had) ──
  if (url.startsWith('/api/')) {
    const body = await readBody(req);
    try {
      const out = await FUNCTIONS.nse({ httpMethod: req.method, body, headers: req.headers });
      res.writeHead(out.statusCode || 200, { ...CORS, ...(out.headers || {}) }).end(out.body || '');
    } catch (e) {
      res.writeHead(500, CORS).end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Persistent store: GET/PUT /store/NAMESPACE ──
  const storeMatch = url.match(/^\/store\/([a-z_]+)/);
  if (storeMatch) {
    const ns = storeMatch[1];
    if (!STORE_NS.has(ns)) { res.writeHead(404, CORS).end(JSON.stringify({ error: 'unknown namespace' })); return; }
    if (req.method === 'GET') {
      const val = storeGet(ns);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
         .end(JSON.stringify({ ns, value: val, ok: true }));
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body || '{}');
        storePut(ns, parsed.value ?? parsed);
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
           .end(JSON.stringify({ ns, ok: true, at: null }));
      } catch (e) {
        res.writeHead(400, CORS).end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  // ── Self-clean: unregister the service worker + clear caches, then reload ──
  // A one-visit fix when a stale SW keeps serving a bad cached response.
  if (url.startsWith('/reset')) {
    const html = `<!doctype html><meta charset=utf-8>
<title>Resetting…</title>
<body style="background:#04080e;color:#e8edf5;font:14px monospace;padding:40px">
<div id=m>Clearing cache and service worker…</div>
<script>
(async () => {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
    if (window.caches) {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
    }
    document.getElementById('m').textContent = 'Done. Loading the app…';
  } catch (e) {
    document.getElementById('m').textContent = 'Cleared. Loading…';
  }
  setTimeout(() => { location.replace('/'); }, 800);
})();
</script></body>`;
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
    return;
  }

  // ── Client hands the server its Kite token so the OI cron can run ──
  if (url === '/kite-token' && (req.method === 'POST' || req.method === 'PUT')) {
    const body = await readBody(req);
    try {
      const j = JSON.parse(body || '{}');
      if (j.access_token && j.api_key) { OI.token = j.access_token; OI.apiKey = j.api_key; OI.saveTok(); }
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, cronArmed: !!OI.token }));
    } catch (e) { res.writeHead(400, CORS).end(JSON.stringify({ error: e.message })); }
    return;
  }

  // ── Server-built continuous OI history (seeds the client's rolling window) ──
  if (url.startsWith('/oi-history')) {
    const idx = (url.split('?')[0].split('/')[2] || '').toUpperCase();
    const payload = idx ? { [idx]: OI.hist[idx] || [] } : OI.hist;
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
       .end(JSON.stringify({ ok: true, marketOpen: OI.marketOpen(), armed: !!OI.token, history: payload }));
    return;
  }

  // ── Health check for Render ──
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
       .end(JSON.stringify({ ok: true, dataDir: DATA_DIR, functions: Object.keys(FUNCTIONS),
         oiCron: { armed: !!OI.token, marketOpen: OI.marketOpen(), indices: Object.keys(OI.hist), snapshots: Object.fromEntries(Object.entries(OI.hist).map(([k,v])=>[k,v.length])) } }));
    return;
  }

  // ── Everything else: static / SPA shell ──
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  ensureDataDir();
  OI.load();
  // Continuous OI snapshots every 30s (no-op outside market hours / without a token)
  setInterval(() => { OI.tick().catch(() => {}); }, 30000);
  console.log(`KHABAR server on :${PORT}  ·  data dir ${DATA_DIR}  ·  functions ${Object.keys(FUNCTIONS).join(', ')}  ·  OI cron armed=${!!OI.token}`);
});
