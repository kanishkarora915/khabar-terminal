# KHABAR — Professional Trading Terminal
## Complete Project Documentation
### Last Updated: 20 March 2026

---

## OVERVIEW
KHABAR is a real-time Indian stock market trading terminal deployed on Netlify. Single HTML file app with 4 serverless backend functions. PWA installable. License key system with admin email approval.

---

## LIVE URLs

| Purpose | URL |
|---------|-----|
| **App** | https://khabar-terminal.netlify.app |
| **GitHub Repo** | https://github.com/kanishkarora915/khabar-terminal |
| **Admin Panel** | https://khabar-terminal.netlify.app/.netlify/functions/auth?action=panel&secret=KHABAR_ADMIN_2024_SECURE |

---

## 4 DASHBOARDS

### Dashboard 1: EQUITY
- Stock search with autocomplete (NSE)
- Real-time candlestick chart (Lightweight Charts v4)
- Technical indicators: SMA 20/50/200, RSI, MACD, Bollinger
- AI-powered analysis with buy/sell/hold signal
- Sector heatmap
- Top gainers/losers
- Bank NIFTY OI analysis
- Market news feed

### Dashboard 2: F&O (Options)
- NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY option chain
- Real-time OI, OI Change, Volume, IV, LTP for calls & puts
- Greeks panel (Delta, Gamma, Theta, Vega) — clickable per strike
- PCR (Put-Call Ratio) with trend
- Max Pain calculation
- OI Flash Alerts (spike detection)
- Seller vs Buyer dominance analysis
- ATM strike highlighting

### Dashboard 3: PULSE (Global)
- Global indices: US (S&P500, Dow, Nasdaq), Europe, Asia
- Commodities: Gold, Silver, Crude Oil, Natural Gas
- Forex: USD/INR, EUR/USD, GBP/USD
- Crypto: BTC, ETH
- India VIX with gauge
- FII/DII data (real NSE endpoint)
- Fear & Greed Index (computed: VIX 40%, Breadth 20%, PCR 20%, Momentum 20%)
- Market breadth (advances/declines)
- Smart money flow tracker
- Bond yields
- Sector rotation map
- IPO calendar (Finnhub API)
- Economic calendar (Finnhub API)
- India news (9 RSS feeds) + Global news (Finnhub)

### Dashboard 4: TRADE OPTIONS
- Auto strike suggestions (call/put with confidence %)
- Institutional reversal detection (hidden bullish/bearish patterns)
- Buyers vs Sellers deep analysis per strike
- Volume profile (ATM +/- 6 strikes)
- Monthly candle levels (high, low, 50%)
- Old OI vs New OI building visualization
- Astro planet levels (manual input, saved to localStorage)
- Gann Square of 9 (auto-calculated from spot price)
- Astro trade suggestions

---

## FILE STRUCTURE

```
khabar-final/
├── index.html              # Main app (~4300 lines) — ALL 4 dashboards
├── netlify.toml            # Netlify config (functions, headers, redirects)
├── package.json            # Dependencies (@netlify/blobs)
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker (cache + offline)
├── icon.svg                # Vector app icon
├── icon-192.png            # 192x192 PNG icon
├── icon-512.png            # 512x512 PNG icon
├── .gitignore              # node_modules/, .netlify/
└── netlify/functions/
    ├── auth.js             # License keys + admin approval + email
    ├── kite.js             # Zerodha Kite API proxy
    ├── nse.js              # NSE India + Yahoo Finance proxy
    ├── finnhub.js          # Finnhub global data proxy
    └── news.js             # RSS news aggregator (9 feeds)
```

---

## API KEYS & CREDENTIALS

### Finnhub (Global Markets)
- **Key**: `d6umfm9r01qig5453qegd6umfm9r01qig5453qf0`
- **Location**: Hardcoded in `netlify/functions/finnhub.js` line 4
- **Free tier**: 60 calls/minute

### Zerodha Kite
- **API Key + Secret**: Entered by each user, saved in their localStorage
- **Access Token**: Generated daily via OAuth redirect flow
- **Proxy**: `netlify/functions/kite.js`
- **Token exchange**: Server-side (secret never exposed to client)
- **Daily re-login required** (SEBI/Zerodha mandate)

### Resend (Email notifications)
- **API Key**: Set as Netlify env var `RESEND_API_KEY`
- **Free tier**: 100 emails/day, 3000/month
- **From address**: `onboarding@resend.dev` (free tier)
- **To**: kanishkarora200@gmail.com

### NSE India
- **No API key needed** — cookie-based session
- **Issue**: NSE Akamai CDN blocks cloud IPs (AWS/Netlify)
- **Workaround**: Kite API used for quotes, NSE for option chain structure
- **Cookie refresh**: Auto-retry with 3 different pages

### Yahoo Finance
- **No API key needed**
- **Used for**: Historical chart data, global indices
- **Endpoints**: query1.finance.yahoo.com, query2.finance.yahoo.com (fallback)
- **Indian index mapping**: NIFTY 50 → ^NSEI, BANKNIFTY → ^NSEBANK, etc.

---

## NETLIFY ENVIRONMENT VARIABLES (set in Netlify Dashboard)

| Variable | Value | Purpose |
|----------|-------|---------|
| `RESEND_API_KEY` | `re_xxxxxxx` | Email notifications for approval |
| `ADMIN_SECRET` | `KHABAR_ADMIN_2024_SECURE` | Admin panel + approve/reject URLs |

---

## LICENSE KEY SYSTEM

### 10 Keys:
| # | Key | User |
|---|-----|------|
| 1 | `KHABAR-PRO-8X2K9` | User 1 |
| 2 | `KHABAR-PRO-4M7NW` | User 2 |
| 3 | `KHABAR-PRO-6T3QP` | User 3 |
| 4 | `KHABAR-PRO-9R5VJ` | User 4 |
| 5 | `KHABAR-PRO-1Y8HC` | User 5 |
| 6 | `KHABAR-PRO-3F6DL` | User 6 |
| 7 | `KHABAR-PRO-7W2BS` | User 7 |
| 8 | `KHABAR-PRO-5A9GT` | User 8 |
| 9 | `KHABAR-PRO-2E4MR` | User 9 |
| 10 | `KHABAR-PRO-0J1ZX` | User 10 |

### Approval Flow:
1. User enters key → `auth.js` validates key exists
2. First time: saves "pending" to Netlify Blobs + sends email to admin
3. User sees "Waiting for approval..." screen (polls every 5s)
4. Admin gets email with APPROVE / REJECT buttons
5. Admin clicks APPROVE → Netlify Blobs updated → user auto-unlocks
6. Key + approval saved to user's localStorage (lifetime access)

### Admin Actions:
- **Approve**: `?action=approve&key=KHABAR-PRO-XXXXX&secret=ADMIN_SECRET`
- **Reject**: `?action=reject&key=KHABAR-PRO-XXXXX&secret=ADMIN_SECRET`
- **Panel**: `?action=panel&secret=ADMIN_SECRET`
- **Deactivate key**: Set `active: false` in `auth.js` VALID_KEYS object

### Storage:
- **Netlify Blobs** (store name: `khabar-approvals`)
- Persists across deploys
- Package: `@netlify/blobs` (in package.json)

---

## DATA FLOW ARCHITECTURE

```
User Browser (index.html)
  ├── Kite API calls → /.netlify/functions/kite → api.kite.trade
  ├── NSE API calls → /.netlify/functions/nse → www.nseindia.com
  ├── News calls → /.netlify/functions/news → RSS feeds (9 sources)
  ├── Finnhub calls → /.netlify/functions/finnhub → finnhub.io
  ├── Auth calls → /.netlify/functions/auth → Netlify Blobs + Resend
  └── Yahoo Finance → /.netlify/functions/nse (history action) → query1.finance.yahoo.com
```

---

## CRITICAL BUG FIXES (History)

### 1. Token Expiry on Dashboard 4
- **Bug**: `kite.js` treated `InputException` same as `TokenException`
- **Impact**: Visiting Dashboard 4 killed Kite token for ALL dashboards
- **Fix**: Only `TokenException` triggers `_tokenExpired: true` in kite.js
- **Client fix**: `kiteApi()` requires both `_tokenExpired === true` AND 401 status

### 2. Error Toast Spam on Refresh
- **Bug**: Every 15s refresh showed "All sources failed" toast
- **Fix**: If old data exists in `APP.fno.data`, silently keep it on refresh failure

### 3. Dashboard 4 Re-fetching Data
- **Bug**: `loadTradeOptions()` called `loadFnO()` even when data already loaded
- **Fix**: Check `APP.fno.data?.records?.data?.length && APP.fno.index === index`

### 4. FII/DII Showing Fake Data
- **Bug**: Was using `Math.random()` for values
- **Fix**: Real NSE endpoint `/api/fiidiiTradeReact`

### 5. NSE IP Blocking
- **Issue**: NSE Akamai CDN blocks AWS/cloud IPs
- **Workaround**: Kite API for live quotes, NSE cookies refreshed from multiple pages

---

## KEY JAVASCRIPT FUNCTIONS (index.html)

### Core:
- `kiteApi(action, params)` — Kite API calls with token management
- `nseApi(action, params)` — NSE proxy calls
- `initDashboard()` — Loads all initial data
- `startRefresh()` — Sets up all auto-refresh timers
- `showPage(page, btn)` — Dashboard tab switching

### Dashboard 1 (Equity):
- `analyzeStock()` — Full stock analysis pipeline
- `loadChart(symbol, range, interval)` — Candlestick chart with indicators
- `refreshIndices()` — Ticker tape data
- `refreshGainersLosers()` — Top movers
- `refreshBankOI()` — Bank NIFTY OI widget

### Dashboard 2 (F&O):
- `loadFnO(index)` — Load option chain (Kite → NSE fallback)
- `processAndRenderOC(data, index)` — Render OC table + all analysis
- `detectOISpikes(data)` — OI Flash Alerts
- `renderSellerBuyer(data)` — Seller vs Buyer analysis
- `renderGreeksForStrike(strike)` — Greeks panel
- `selectStrike(strike)` — Click strike in OC table

### Dashboard 3 (Pulse):
- `loadPulseData()` — All global data in parallel
- `refreshPulse()` — Auto-refresh
- `loadFearGreed()` — Fear & Greed computation
- `loadIPOCalendar()` — Finnhub IPO data
- `loadEconomicCalendar()` — Finnhub economic events

### Dashboard 4 (Trade Options):
- `loadTradeOptions()` — Main loader (reuses F&O data)
- `renderAllTradeOptions()` — Renders all 9 features
- `renderStrikeSuggestions()` — Auto call/put suggestions
- `renderReversalDetection()` — Institutional reversal patterns
- `renderBuyersSellersDeep()` — Deep OI analysis
- `renderVolumeProfile()` — Volume at strikes
- `renderOldVsNewOI()` — OI building comparison
- `renderMonthlyLevels()` — Monthly candle levels
- `addAstroLevel() / removeAstroLevel()` — Astro planet management
- `renderGannLevels()` — Gann Square of 9
- `renderAstroSuggestions()` — Trade suggestions near astro levels

### Auth & PWA:
- `validateLicense()` — License key entry + approval request
- `checkLicenseOnLoad()` — Auto-validate saved license
- `startApprovalPolling(key)` — 5s interval checking approval
- `installPWA()` — PWA install prompt

---

## APP STATE OBJECT

```javascript
const APP = {
  page: 'equity',           // Current tab
  stock: null,              // Current stock data
  fno: { data: null, index: 'NIFTY', expiry: '' },
  options: { index: 'NIFTY', astroLevels: [], monthlyCandle: null },
  newsItems: [],
  seenNews: new Set(),
  pulseData: {},
  timers: {},               // setInterval references
  connected: false,
  chartRange: '3mo',
  chartInterval: '1d',
  kite: { api_key: '', api_secret: '', access_token: '', active: false }
};
```

---

## REFRESH TIMERS

| Data | Interval | Condition |
|------|----------|-----------|
| Indices (ticker tape) | 10s | Always |
| News (9 RSS + Finnhub) | 45s | Always |
| Bank NIFTY OI | 30s | Equity page |
| Option Chain | 15s | F&O or Trade Options page |
| Pulse (global data) | 30s | Pulse page |
| Clock | 1s | Always |

---

## NEWS SOURCES (9 RSS Feeds)

1. MoneyControl Top News
2. MoneyControl Market Reports
3. MoneyControl Latest News
4. Economic Times Markets
5. Economic Times Top
6. LiveMint Markets
7. LiveMint Money
8. Business Standard Markets
9. NDTV Profit

Plus: Finnhub market news (global)

---

## DEPLOYMENT

### Netlify Settings:
- **Build**: No build command (static site)
- **Publish**: `.` (root directory)
- **Functions**: `netlify/functions/`
- **Node bundler**: esbuild
- **External modules**: `https`, `@netlify/blobs`
- **Kite function timeout**: 26s
- **Auth function timeout**: 15s

### To Deploy:
1. Push to `main` branch on GitHub → auto-deploys
2. OR: Upload zip to Netlify dashboard

---

## ADMIN EMAIL
kanishkarora200@gmail.com

## ADMIN SECRET
KHABAR_ADMIN_2024_SECURE (change in Netlify env vars)

---

## FUTURE WORK / IDEAS
- [ ] Add more license keys (edit VALID_KEYS in auth.js)
- [ ] Custom domain setup
- [ ] User names in license keys (e.g., "Rahul" instead of "User 1")
- [ ] Telegram bot notifications (alternative to email)
- [ ] Multi-timeframe charts
- [ ] Options P&L calculator
- [ ] Position tracking / portfolio
- [ ] Alert system (price/OI alerts)
- [ ] Dark/light theme toggle
- [ ] Mobile-optimized layout improvements
