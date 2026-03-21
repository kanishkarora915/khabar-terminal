// Real-time Indian + Global Market News from RSS Feeds — No API Key Needed
const https = require('https');
const http = require('http');

let newsCache = { data: null, ts: 0 };
const NEWS_TTL = 30000; // 30s — faster refresh

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const proto = u.protocol === 'https:' ? https : http;
    const req = proto.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/xml, application/rss+xml, text/xml, */*'
      }
    }, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchURL(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function parseRSS(xml, source, category = 'market') {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const it = m[1];
    const title = (it.match(/<title><!\[CDATA\[(.*?)\]\]>/) || it.match(/<title>([^<]+)<\/title>/) || ['', ''])[1];
    const link = (it.match(/<link><!\[CDATA\[(.*?)\]\]>/) || it.match(/<link>([^<]+)<\/link>/) || it.match(/<link[^>]*href="(.*?)"/) || ['', ''])[1];
    const pubDate = (it.match(/<pubDate><!\[CDATA\[(.*?)\]\]>/) || it.match(/<pubDate>([^<]+)<\/pubDate>/) || it.match(/<dc:date>([^<]+)<\/dc:date>/) || ['', ''])[1];
    const desc = (it.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/) || it.match(/<description>([^<]*(?:<[^>]*>[^<]*)*?)<\/description>/) || ['', ''])[1];
    if (title && title.length > 10) {
      const clean = desc.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim().slice(0, 250);

      // Detect high impact news
      const hi = /RBI|SEBI|rate cut|rate hike|FII|DII|GDP|inflation|crash|circuit|halt|ban|IPO|result|earning|profit|loss|acqui|merger|scam|fraud|FPI|repo rate|nifty|sensex|bank nifty|market crash|rally|selloff|sell-off|bull run|bear|bloodbath|tank|surge|plunge|soar|breakout|breakdown|tariff|trade war|sanction|recession|CPI|PMI|Fed|budget|tax|demerger|bonus|split|buyback|dividend|Q[1-4]\s*result|war|geopolit|nuclear|missile|attack|invasion|ceasefire|NATO|Trump|Modi|Xi Jinping|Putin|OPEC|oil crisis|embargo/i.test(title);

      // Detect geopolitical news
      const isGeo = /war|geopolit|nuclear|missile|attack|invasion|ceasefire|NATO|military|troops|border|conflict|sanction|embargo|diplomacy|summit|tension|strike|drone|weapon|defence|defense|terror|blast|Kashmir|Pakistan|China|Russia|Ukraine|Israel|Gaza|Iran|North Korea|Taiwan|South China Sea|trade war|tariff|cold war|axis|alliance|coup|protest|riot/i.test(title + ' ' + clean);

      items.push({
        title: title.trim(),
        link: link.trim(),
        time: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        desc: clean,
        source,
        highImpact: hi,
        category,
        isGeo
      });
    }
  }
  return items;
}

exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=25'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  if (newsCache.data && Date.now() - newsCache.ts < NEWS_TTL) {
    return { statusCode: 200, headers: H, body: JSON.stringify(newsCache.data) };
  }

  try {
    const feeds = [
      // === INDIA MARKET NEWS (fastest, verified working) ===
      { url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', source: 'ET Markets', cat: 'market' },
      { url: 'https://economictimes.indiatimes.com/rssfeedstopnews.cms', source: 'ET Top', cat: 'market' },
      { url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml', source: 'CNBC-TV18', cat: 'market' },
      { url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/economy.xml', source: 'CNBC Economy', cat: 'market' },
      { url: 'https://www.livemint.com/rss/markets', source: 'LiveMint', cat: 'market' },
      { url: 'https://www.livemint.com/rss/money', source: 'Mint Money', cat: 'market' },
      { url: 'https://www.moneycontrol.com/rss/marketreports.xml', source: 'MC Markets', cat: 'market' },
      { url: 'https://www.moneycontrol.com/rss/latestnews.xml', source: 'MC Latest', cat: 'market' },

      // === GEOPOLITICAL / WORLD NEWS (verified working) ===
      { url: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms', source: 'TOI World', cat: 'geo' },
      { url: 'https://feeds.feedburner.com/ndtvnews-world-news', source: 'NDTV World', cat: 'geo' },
      { url: 'https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml', source: 'HT World', cat: 'geo' },
      { url: 'https://www.livemint.com/rss/politics', source: 'Mint Politics', cat: 'geo' },
    ];

    const results = await Promise.allSettled(feeds.map(async f => {
      try {
        const xml = await fetchURL(f.url);
        return parseRSS(xml, f.source, f.cat);
      } catch(e) {
        return [];
      }
    }));

    let all = [];
    results.forEach(r => { if (r.status === 'fulfilled') all = all.concat(r.value); });

    // Deduplicate by title similarity
    const seen = new Set();
    all = all.filter(n => {
      const key = n.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    all.sort((a, b) => new Date(b.time) - new Date(a.time));
    all = all.slice(0, 120); // More news items

    newsCache = { data: all, ts: Date.now() };
    return { statusCode: 200, headers: H, body: JSON.stringify(all) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
