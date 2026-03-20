// Real-time Indian Market News from RSS Feeds — No API Key Needed
const https = require('https');

let newsCache = { data: null, ts: 0 };
const NEWS_TTL = 40000; // 40s — fast refresh for market-moving news

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/xml, text/xml, */*' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function parseRSS(xml, source) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const it = m[1];
    const title = (it.match(/<title><!\[CDATA\[(.*?)\]\]>/) || it.match(/<title>(.*?)<\/title>/) || ['', ''])[1];
    const link = (it.match(/<link>(.*?)<\/link>/) || ['', ''])[1];
    const pubDate = (it.match(/<pubDate>(.*?)<\/pubDate>/) || ['', ''])[1];
    const desc = (it.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/) || it.match(/<description>([\s\S]*?)<\/description>/) || ['', ''])[1];
    if (title) {
      const clean = desc.replace(/<[^>]*>/g, '').trim().slice(0, 200);
      // Detect high impact
      const hi = /RBI|SEBI|rate cut|rate hike|FII|DII|GDP|inflation|crash|circuit|halt|ban|IPO|result|earning|profit|loss|acqui|merger|scam|fraud|FPI|repo rate|nifty|sensex|bank nifty|market crash|rally|selloff|sell-off|bull run|bear|bloodbath|tank|surge|plunge|soar|breakout|breakdown|tariff|war|sanction|recession|CPI|PMI|Fed|budget|tax|demerger|bonus|split|buyback|dividend|Q[1-4]\s*result/i.test(title);
      items.push({ title: title.trim(), link: link.trim(), time: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(), desc: clean, source, highImpact: hi });
    }
  }
  return items;
}

exports.handler = async (event) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  if (newsCache.data && Date.now() - newsCache.ts < NEWS_TTL) {
    return { statusCode: 200, headers: H, body: JSON.stringify(newsCache.data) };
  }

  try {
    const feeds = [
      { url: 'https://www.moneycontrol.com/rss/MCtopnews.xml', source: 'MoneyControl' },
      { url: 'https://www.moneycontrol.com/rss/marketreports.xml', source: 'MC Markets' },
      { url: 'https://www.moneycontrol.com/rss/latestnews.xml', source: 'MC Latest' },
      { url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', source: 'ET Markets' },
      { url: 'https://economictimes.indiatimes.com/rssfeedstopnews.cms', source: 'ET Top' },
      { url: 'https://www.livemint.com/rss/markets', source: 'LiveMint' },
      { url: 'https://www.livemint.com/rss/money', source: 'Mint Money' },
      { url: 'https://www.business-standard.com/rss/markets-106.rss', source: 'BS Markets' },
      { url: 'https://www.ndtv.com/rss/profit/latest', source: 'NDTV Profit' },
    ];

    const results = await Promise.allSettled(feeds.map(async f => {
      const xml = await fetchURL(f.url);
      return parseRSS(xml, f.source);
    }));

    let all = [];
    results.forEach(r => { if (r.status === 'fulfilled') all = all.concat(r.value); });
    all.sort((a, b) => new Date(b.time) - new Date(a.time));
    all = all.slice(0, 80);

    newsCache = { data: all, ts: Date.now() };
    return { statusCode: 200, headers: H, body: JSON.stringify(all) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
