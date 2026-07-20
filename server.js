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

  // ── Health check for Render ──
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
       .end(JSON.stringify({ ok: true, dataDir: DATA_DIR, functions: Object.keys(FUNCTIONS) }));
    return;
  }

  // ── Everything else: static / SPA shell ──
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  ensureDataDir();
  console.log(`KHABAR server on :${PORT}  ·  data dir ${DATA_DIR}  ·  functions ${Object.keys(FUNCTIONS).join(', ')}`);
});
