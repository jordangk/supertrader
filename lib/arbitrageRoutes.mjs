/**
 * Cross-venue arb monitor: Kalshi vs Polymarket — websocket-driven live prices.
 * Requires Postgres tables from scripts/sql/arbitrage_tables.sql
 * Env: ARB_DATABASE_URL or DB_HOST + DB_PORT + DB_DATABASE + DB_USERNAME + DB_PASSWORD
 */
import pg from 'pg';
import WebSocket from 'ws';
import { extractKalshiTicker, fetchKalshiYesPrice, KALSHI_TRADE_API } from './kalshiPrice.mjs';
import { kalshiFetch, kalshiAuthHeaders, hasKalshiAuth } from './kalshiAuth.mjs';

/** Last path segment from a polymarket.com URL, or the string unchanged if not a Poly URL. */
export function extractPolymarketSlug(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (!/polymarket\.com/i.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    return last || s;
  } catch {
    return s;
  }
}

/** fetch() requires a scheme; bare kalshi.com/… or polymarket.com/… fails otherwise. */
export function normalizeFetchUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^(?:www\.)?(?:kalshi|polymarket)\.com\b/i.test(s)) return `https://${s}`;
  return s;
}

function looksKalshiInput(s) {
  const n = normalizeFetchUrl(String(s || '').trim());
  if (!n) return false;
  if (/kalshi\.com/i.test(n) || /^kalshi:\/\//i.test(n)) return true;
  return Boolean(extractKalshiTicker(n));
}

function looksPolymarketUrl(s) {
  return /polymarket\.com/i.test(String(s || ''));
}

const { Pool } = pg;

function buildPool() {
  if (process.env.ARB_DATABASE_URL) {
    return new Pool({
      connectionString: process.env.ARB_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  const u = process.env.DB_USERNAME;
  const p = process.env.DB_PASSWORD;
  const h = process.env.DB_HOST;
  const port = process.env.DB_PORT || '5432';
  const db = process.env.DB_DATABASE || 'postgres';
  if (!u || !h || p === undefined) return null;
  const conn = `postgresql://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${h}:${port}/${db}`;
  return new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
}

const pool = buildPool();

/** Per-session state: interval, websockets, live price cache. */
const sessions = new Map();

/* ── Kalshi WS ──────────────────────────────────────────────── */

const KALSHI_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const KALSHI_API_KEY = process.env.KALSHI_API_KEY || '';

function connectKalshiWs(ticker, cache, label) {
  let ws;
  let alive = true;
  const tag = `[arb-kalshi-ws:${label}]`;

  function open() {
    if (!alive) return;
    try {
      const authHdrs = kalshiAuthHeaders('GET', '/trade-api/ws/v2');
      ws = new WebSocket(KALSHI_WS_URL, { headers: authHdrs });
    } catch (e) {
      console.error(tag, 'ws construct error', e.message);
      setTimeout(open, 5000);
      return;
    }

    ws.on('open', () => {
      console.log(tag, 'connected, subscribing to', ticker);
      cache.wsConnected = true;
      ws.send(JSON.stringify({
        id: 1,
        cmd: 'subscribe',
        params: { channels: ['ticker'], market_tickers: [ticker] },
      }));
      ws.send(JSON.stringify({
        id: 2,
        cmd: 'subscribe',
        params: { channels: ['orderbook_delta'], market_tickers: [ticker] },
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ticker' && msg.msg) {
          const m = msg.msg;
          const yb = parseFloat(m.yes_bid);
          const ya = parseFloat(m.yes_ask);
          const nb = parseFloat(m.no_bid);
          const na = parseFloat(m.no_ask);
          const last = parseFloat(m.last_price);
          if (!Number.isNaN(yb)) cache.yesBid = yb / 100;
          if (!Number.isNaN(ya)) cache.yesAsk = ya / 100;
          if (!Number.isNaN(nb)) cache.noBid = nb / 100;
          if (!Number.isNaN(na)) cache.noAsk = na / 100;
          if (!Number.isNaN(last)) cache.last = last / 100;
          cache.updated = Date.now();
        }
        if ((msg.type === 'orderbook_snapshot' || msg.type === 'orderbook_delta') && msg.msg) {
          const m = msg.msg;
          // Parse full book: arrays of [price_cents, quantity]
          if (m.yes?.length) {
            const levels = m.yes.filter(l => l[0] > 0).sort((a, b) => b[0] - a[0]);
            if (levels[0]) cache.yesBid = levels[0][0] / 100;
            // Ask side for YES = lowest NO bid, but we can also compute depth at ask
            // Store raw yes book for depth queries
            cache.yesBook = levels.map(l => ({ price: l[0] / 100, qty: l[1] }));
          }
          if (m.no?.length) {
            const levels = m.no.filter(l => l[0] > 0).sort((a, b) => b[0] - a[0]);
            if (levels[0]) cache.noBid = levels[0][0] / 100;
            cache.noBook = levels.map(l => ({ price: l[0] / 100, qty: l[1] }));
          }
          cache.updated = Date.now();
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on('close', () => {
      console.log(tag, 'disconnected, reconnecting in 3s');
      if (alive) setTimeout(open, 3000);
    });

    ws.on('error', (e) => {
      console.error(tag, 'error:', e.message);
      try { ws.close(); } catch {}
    });
  }

  open();

  return {
    close() {
      alive = false;
      try { ws?.close(); } catch {}
    },
  };
}

/* ── Polymarket CLOB WS ────────────────────────────────────── */

function connectPolyWs(tokenIds, cache, label) {
  let ws;
  let alive = true;
  const tag = `[arb-poly-ws:${label}]`;

  function open() {
    if (!alive) return;
    try {
      ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    } catch (e) {
      console.error(tag, 'ws construct error', e.message);
      setTimeout(open, 5000);
      return;
    }

    ws.on('open', () => {
      console.log(tag, 'connected, subscribing to', tokenIds.length, 'tokens');
      ws.send(JSON.stringify({ assets_ids: tokenIds, type: 'market' }));
    });

    ws.on('message', (raw) => {
      try {
        const msgs = JSON.parse(raw.toString());
        const list = Array.isArray(msgs) ? msgs : [msgs];
        for (const msg of list) {
          if (!msg.asset_id) continue;
          const price = parseFloat(msg.price);
          if (Number.isNaN(price)) continue;
          const idx = tokenIds.indexOf(msg.asset_id);
          if (idx === 0) { cache.up = price; cache.updated = Date.now(); }
          else if (idx === 1) { cache.down = price; cache.updated = Date.now(); }
        }
      } catch { /* ignore */ }
    });

    ws.on('close', () => {
      console.log(tag, 'disconnected, reconnecting in 3s');
      if (alive) setTimeout(open, 3000);
    });

    ws.on('error', (e) => {
      console.error(tag, 'error:', e.message);
      try { ws.close(); } catch {}
    });
  }

  open();

  return {
    close() {
      alive = false;
      try { ws?.close(); } catch {}
    },
  };
}

/* ── Resolve Kalshi ticker from URL ─────────────────────────── */

const UA = 'Mozilla/5.0 (compatible; SuperTrader-Arb/1.0)';

async function resolveKalshiTicker(extUrl) {
  let ticker = extractKalshiTicker(extUrl);

  // Try as market ticker first
  if (ticker) {
    const k = await fetchKalshiYesPrice(ticker);
    if (k.price != null) return { ticker: k.raw?.ticker || ticker, initial: k };
    // If 404, the extracted ticker might be an event ticker — resolve child markets
    if (k.error && /404/.test(k.error)) {
      const resolved = await resolveEventTicker(ticker);
      if (resolved) {
        const k2 = await fetchKalshiYesPrice(resolved);
        if (k2.price != null) return { ticker: resolved, initial: k2 };
      }
    }
    return { ticker, initial: k };
  }

  // Try scraping HTML for ticker
  if (/kalshi\.com/i.test(extUrl)) {
    try {
      const page = await fetch(extUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      const html = await page.text();
      ticker = extractKalshiTicker(html) || extractKalshiTicker(decodeURIComponent(extUrl));
      if (ticker) {
        const k = await fetchKalshiYesPrice(ticker);
        if (k.price != null) return { ticker: k.raw?.ticker || ticker, initial: k };
      }
    } catch {}
  }

  return { ticker: null, initial: { price: null, error: 'Could not resolve Kalshi ticker' } };
}

async function resolveEventTicker(eventTicker) {
  try {
    const q = new URLSearchParams({ event_ticker: eventTicker, limit: '50' });
    const res = await kalshiFetch(`${KALSHI_TRADE_API}/markets?${q}`);
    if (!res.ok) return null;
    const j = await res.json();
    const list = j.markets;
    if (!Array.isArray(list) || !list.length) return null;
    const tickers = list.map(m => m.ticker).filter(Boolean);
    return tickers.sort()[0];
  } catch {
    return null;
  }
}

/* ── Resolve Polymarket token IDs from slug ─────────────────── */

async function resolvePolyTokens(slug) {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
    const arr = await res.json();
    const m = arr?.[0]?.markets?.[0];
    if (!m) return { error: 'Gamma: no market for slug' };
    const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    if (!tokens?.[0] || !tokens?.[1]) return { error: 'Missing clobTokenIds' };
    const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;

    // Fetch initial prices via REST
    const [up, down] = await Promise.all([
      fetch(`https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokens[0])}&side=sell`).then(r => r.json()).then(d => parseFloat(d.price)).catch(() => null),
      fetch(`https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokens[1])}&side=sell`).then(r => r.json()).then(d => parseFloat(d.price)).catch(() => null),
    ]);

    return { tokens, outcomes: outcomes || ['Up', 'Down'], question: m.question || m.slug, up, down, negRisk: !!m.negRisk };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

/* ── Find matching event on the other platform (DeepSeek) ──── */

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

async function deepseekChat(prompt) {
  if (!DEEPSEEK_KEY) throw new Error('DEEPSEEK_API_KEY not configured');
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${t.slice(0, 200)}`);
  }
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

/** Category mapping: Poly tag/slug patterns → Kalshi series tickers to search. */
const CATEGORY_MAP = [
  { polyTag: 'tennis', polySlug: /^atp-/i, kalshiSeries: ['KXATPMATCH', 'KXATPCHALLENGERMATCH'] },
  { polyTag: 'basketball', polySlug: /^nba-/i, kalshiSeries: ['KXNBAGAME'] },
  { polyTag: 'hockey', polySlug: /^nhl-/i, kalshiSeries: ['KXNHLGAME'] },
  { polyTag: 'football', polySlug: /^nfl-/i, kalshiSeries: ['KXNFLGAME'] },
  { polyTag: 'baseball', polySlug: /^mlb-/i, kalshiSeries: ['KXMLBGAME'] },
  { polyTag: 'mma', polySlug: /^ufc-/i, kalshiSeries: ['KXUFCFIGHT'] },
  { polyTag: 'soccer', polySlug: /^soccer-|^epl-|^mls-/i, kalshiSeries: ['KXSOCCERMATCH'] },
  { polyTag: 'crypto', polySlug: /^btc-updown-/i, kalshiSeries: ['KXBTC15M', 'KXBTC5M', 'KXBTC1H'] },
  { polyTag: 'crypto', polySlug: /^eth-updown-/i, kalshiSeries: ['KXETH15M', 'KXETH5M'] },
  { polyTag: 'crypto', polySlug: /^sol-updown-/i, kalshiSeries: ['KXSOL15M', 'KXSOL5M'] },
];

async function fetchKalshiBySeries(seriesTickers) {
  const all = [];
  await Promise.all(seriesTickers.map(async (st) => {
    try {
      const res = await kalshiFetch(`${KALSHI_TRADE_API}/events?status=open&series_ticker=${st}&limit=100`);
      if (!res.ok) return;
      const d = await res.json();
      (d.events || []).forEach(e => all.push({
        ticker: e.event_ticker,
        title: e.title,
        category: e.category,
        seriesTicker: e.series_ticker,
      }));
    } catch {}
  }));
  return all;
}

async function fetchPolyByTag(tag) {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events?active=true&closed=false&tag=${encodeURIComponent(tag)}&limit=200`);
    if (!res.ok) return [];
    const arr = await res.json();
    return (Array.isArray(arr) ? arr : []).map(e => ({
      slug: e.slug,
      title: e.title,
      question: e.markets?.[0]?.question || e.title,
    }));
  } catch { return []; }
}

/** Detect category from a Polymarket slug/tags or Kalshi series ticker. */
function detectCategory(platform, { slug, tags, seriesTicker }) {
  if (platform === 'polymarket') {
    // Check slug patterns first
    for (const cat of CATEGORY_MAP) {
      if (cat.polySlug && cat.polySlug.test(slug)) return cat;
    }
    // Check tags
    if (tags?.length) {
      const tagSlugs = tags.map(t => (t.slug || t.label || '').toLowerCase());
      for (const cat of CATEGORY_MAP) {
        if (cat.polyTag && tagSlugs.includes(cat.polyTag)) return cat;
      }
    }
  } else {
    // Kalshi: match series ticker
    for (const cat of CATEGORY_MAP) {
      if (cat.kalshiSeries?.some(s => seriesTicker?.startsWith(s))) return cat;
    }
  }
  return null;
}

/**
 * Given one link (Kalshi or Poly), find the matching event on the other platform.
 * 1) Detect the category  2) Fetch from the other platform filtered by that category  3) AI match
 */
/** Crypto up/down time-slot matching — these follow a predictable pattern, no AI needed. */
const CRYPTO_SLOT_MAP = [
  { asset: 'btc', polyRe: /btc-updown-(\d+)m-(\d+)/, kalshiSeries: 'KXBTC', kalshiRe: /KXBTC(\d+)M-/i },
  { asset: 'eth', polyRe: /eth-updown-(\d+)m-(\d+)/, kalshiSeries: 'KXETH', kalshiRe: /KXETH(\d+)M-/i },
  { asset: 'sol', polyRe: /sol-updown-(\d+)m-(\d+)/, kalshiSeries: 'KXSOL', kalshiRe: /KXSOL(\d+)M-/i },
  { asset: 'hype', polyRe: /hype-updown-(\d+)m-(\d+)/, kalshiSeries: 'KXHYPE', kalshiRe: /KXHYPE(\d+)M-/i },
  { asset: 'xrp', polyRe: /xrp-updown-(\d+)m-(\d+)/, kalshiSeries: 'KXXRP', kalshiRe: /KXXRP(\d+)M-/i },
  { asset: 'bnb', polyRe: /bnb-updown-(\d+)m-(\d+)/, kalshiSeries: 'KXBNB', kalshiRe: /KXBNB(\d+)M-/i },
  { asset: 'doge', polyRe: /doge-updown-(\d+)m-(\d+)/, kalshiSeries: 'KXDOGE', kalshiRe: /KXDOGE(\d+)M-/i },
];

async function tryCryptoSlotMatch(inputUrl) {
  const s = String(inputUrl).trim();
  const isPoly = looksPolymarketUrl(s);
  const isKalshi = looksKalshiInput(s);

  for (const cm of CRYPTO_SLOT_MAP) {
    if (isPoly) {
      const slug = extractPolymarketSlug(s);
      const m = slug.match(cm.polyRe);
      if (!m) continue;
      const timeframe = m[1]; // e.g. "15"
      const timestamp = m[2]; // unix seconds
      // Find matching Kalshi event
      const series = `${cm.kalshiSeries}${timeframe}M`;
      try {
        const r = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=${series}&limit=10`);
        const d = await r.json();
        // Match by finding the event whose time window contains our timestamp
        // Or just get the latest/current one
        const events = d.events || [];
        if (!events.length) continue;
        // Get markets for the first event to get the market ticker
        const evTicker = events[0].event_ticker;
        const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${encodeURIComponent(evTicker)}&limit=5`);
        const md = await mr.json();
        const market = md.markets?.[0];
        return {
          kalshiUrl: `https://kalshi.com/markets/${series.toLowerCase()}/${evTicker.toLowerCase()}`,
          kalshiTicker: market?.ticker || evTicker,
          polyUrl: normalizeFetchUrl(inputUrl),
          kalshiTitle: market?.title || events[0].title,
          kalshiYesSub: null,
          kalshiNoSub: null,
          polyTitle: `${cm.asset.toUpperCase()} Up or Down (${timeframe}m)`,
          polyOutcomes: ['Up', 'Down'],
          label: `${cm.asset.toUpperCase()} ${timeframe}m Up/Down`,
        };
      } catch { continue; }
    }

    if (isKalshi) {
      const ticker = extractKalshiTicker(s);
      if (!ticker) continue;
      const m = ticker.match(cm.kalshiRe);
      if (!m) continue;
      const timeframe = m[1]; // e.g. "15"
      // Compute current Poly slot
      const now = Math.floor(Date.now() / 1000);
      const slotSec = parseInt(timeframe) * 60;
      const slot = Math.floor(now / slotSec) * slotSec;
      const polySlug = `${cm.asset}-updown-${timeframe}m-${slot}`;
      const polyUrl = `https://polymarket.com/event/${polySlug}`;
      // Get Kalshi title
      let kalshiTitle = ticker;
      try {
        const r = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(ticker)}`);
        const d = await r.json();
        kalshiTitle = d.market?.title || ticker;
      } catch {}
      return {
        kalshiUrl: normalizeFetchUrl(inputUrl),
        kalshiTicker: ticker,
        polyUrl,
        kalshiTitle,
        kalshiYesSub: null,
        kalshiNoSub: null,
        polyTitle: `${cm.asset.toUpperCase()} Up or Down (${timeframe}m)`,
        polyOutcomes: ['Up', 'Down'],
        label: `${cm.asset.toUpperCase()} ${timeframe}m Up/Down`,
      };
    }
  }
  return null; // Not a crypto slot market
}

async function findMatchForLink(inputUrl) {
  const isKalshi = looksKalshiInput(inputUrl);
  const isPoly = looksPolymarketUrl(inputUrl);
  if (!isKalshi && !isPoly) throw new Error('Link must be from Kalshi or Polymarket');

  // Fast path: crypto time-slot markets (BTC/ETH/SOL up/down)
  const cryptoMatch = await tryCryptoSlotMatch(inputUrl);
  if (cryptoMatch) {
    console.log(`[arb-match] Crypto slot match: ${cryptoMatch.label}`);
    return cryptoMatch;
  }

  let sourceTitle = '';
  let sourcePlatform = '';
  let category = null;
  let candidates = [];

  if (isPoly) {
    sourcePlatform = 'polymarket';
    const slug = extractPolymarketSlug(inputUrl);

    // Fetch event metadata (title + tags)
    let tags = [];
    try {
      const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
      const arr = await r.json();
      const ev = arr?.[0];
      sourceTitle = ev?.title || ev?.markets?.[0]?.question || slug;
      tags = ev?.tags || [];
    } catch { sourceTitle = slug; }

    category = detectCategory('polymarket', { slug, tags });

    if (category) {
      // Fetch Kalshi events in the matching series
      candidates = await fetchKalshiBySeries(category.kalshiSeries);
      console.log(`[arb-match] Poly "${sourceTitle}" → category ${category.polyTag}, searching ${category.kalshiSeries.join(',')} (${candidates.length} events)`);
    } else {
      // Fallback: broad search
      try {
        const res = await kalshiFetch(`${KALSHI_TRADE_API}/events?status=open&limit=200`);
        const d = await res.json();
        candidates = (d.events || []).map(e => ({ ticker: e.event_ticker, title: e.title, category: e.category, seriesTicker: e.series_ticker }));
      } catch {}
      console.log(`[arb-match] Poly "${sourceTitle}" → no category detected, broad search (${candidates.length} events)`);
    }
  } else {
    sourcePlatform = 'kalshi';
    const ticker = extractKalshiTicker(inputUrl);
    let seriesTicker = '';

    if (ticker) {
      // Get title + series from Kalshi
      try {
        const r = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(ticker)}`);
        const d = await r.json();
        sourceTitle = d.market?.title || ticker;
        seriesTicker = d.market?.series_ticker || ticker.split('-')[0];
      } catch { sourceTitle = ticker; seriesTicker = ticker.split('-')[0]; }
    }

    category = detectCategory('kalshi', { seriesTicker });

    if (category) {
      candidates = await fetchPolyByTag(category.polyTag);
      console.log(`[arb-match] Kalshi "${sourceTitle}" → category ${category.polyTag}, searching Poly tag (${candidates.length} events)`);
    } else {
      try {
        const res = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=200');
        const arr = await res.json();
        candidates = (Array.isArray(arr) ? arr : []).map(e => ({ slug: e.slug, title: e.title, question: e.markets?.[0]?.question || e.title }));
      } catch {}
      console.log(`[arb-match] Kalshi "${sourceTitle}" → no category, broad Poly search (${candidates.length} events)`);
    }
  }

  if (!candidates.length) throw new Error(`No candidate events found on ${sourcePlatform === 'kalshi' ? 'Polymarket' : 'Kalshi'}`);

  const targetPlatform = sourcePlatform === 'kalshi' ? 'Polymarket' : 'Kalshi';

  const candidateList = candidates.map((e, i) =>
    `${i}: ${e.title || e.question || ''} [${e.slug || e.ticker}]`
  ).join('\n');

  const prompt = `I have a prediction market event from ${sourcePlatform === 'kalshi' ? 'Kalshi' : 'Polymarket'}:
"${sourceTitle}"

Find the SAME event (same players/teams/asset, same match/timeframe) on ${targetPlatform}:
${candidateList}

Return ONLY a JSON object: {"idx": <number>, "label": "<short description>"}
If no match exists, return {"idx": -1, "label": "no match"}
Return ONLY valid JSON, nothing else.`;

  const aiText = await deepseekChat(prompt);
  const jsonMatch = aiText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI returned no JSON');
  const result = JSON.parse(jsonMatch[0]);

  if (result.idx < 0 || result.idx >= candidates.length) {
    throw new Error(`No matching event found on ${targetPlatform} for "${sourceTitle}"`);
  }

  const match = candidates[result.idx];

  // Step 2: resolve the specific MARKET within both events using AI
  // Fetch all markets from both the source event and matched event
  let kalshiEventTicker, polySlug;
  if (sourcePlatform === 'kalshi') {
    kalshiEventTicker = extractKalshiTicker(inputUrl)?.split('-').length > 1
      ? extractKalshiTicker(inputUrl) : null;
    // For kalshi event ticker, try the market's event_ticker
    if (!kalshiEventTicker) kalshiEventTicker = extractKalshiTicker(inputUrl);
    polySlug = match.slug;
  } else {
    kalshiEventTicker = match.ticker;
    polySlug = extractPolymarketSlug(inputUrl);
  }

  // Fetch markets from both sides in parallel
  const [kalshiMarkets, polyMarkets] = await Promise.all([
    (async () => {
      try {
        const r = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${encodeURIComponent(kalshiEventTicker)}&limit=50`);
        const d = await r.json();
        return (d.markets || []).map(m => ({
          ticker: m.ticker,
          title: m.title,
          subtitle: m.subtitle,
          yesSub: m.yes_sub_title,
          noSub: m.no_sub_title,
        }));
      } catch { return []; }
    })(),
    (async () => {
      try {
        const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(polySlug)}`);
        const arr = await r.json();
        const ev = arr?.[0] || arr;
        return (ev.markets || []).map(m => ({
          question: m.question,
          slug: m.slug || m.conditionId,
          outcomes: typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes,
          clobTokenIds: typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds,
        }));
      } catch { return []; }
    })(),
  ]);

  // If both have multiple markets, use AI to match the specific bet
  let kalshiMarket = kalshiMarkets[0];
  let polyMarket = polyMarkets[0];

  if (kalshiMarkets.length > 0 && polyMarkets.length > 0) {
    const kmList = kalshiMarkets.map((m, i) => `${i}: ${m.title} (Yes=${m.yesSub}, No=${m.noSub})`).join('\n');
    const pmList = polyMarkets.map((m, i) => `${i}: ${m.question} (${m.outcomes?.join(' vs ')})`).join('\n');

    const matchPrompt = `Match the EQUIVALENT specific bets between these two platforms for the same event.

KALSHI markets:
${kmList}

POLYMARKET markets:
${pmList}

Find the best matching pair — same bet type (match winner, set winner, O/U same line, etc).
Prefer match-winner markets if available on both sides.
Return ONLY: {"kalshi_idx": <number>, "poly_idx": <number>, "label": "<what the bet is>"}
Return ONLY valid JSON.`;

    try {
      const mText = await deepseekChat(matchPrompt);
      const mJson = mText.match(/\{[\s\S]*\}/);
      if (mJson) {
        const mResult = JSON.parse(mJson[0]);
        if (mResult.kalshi_idx >= 0 && mResult.kalshi_idx < kalshiMarkets.length) kalshiMarket = kalshiMarkets[mResult.kalshi_idx];
        if (mResult.poly_idx >= 0 && mResult.poly_idx < polyMarkets.length) polyMarket = polyMarkets[mResult.poly_idx];
        result.label = mResult.label || result.label;
        console.log(`[arb-match] Market match: KS "${kalshiMarket.title}" ↔ Poly "${polyMarket.question}"`);
      }
    } catch (e) {
      console.error('[arb-match] Market matching failed:', e.message);
    }
  }

  // Build URLs using the matched market ticker (not event ticker)
  const kTicker = kalshiMarket?.ticker || kalshiEventTicker;
  const kSlug = kTicker.toLowerCase();
  const kSeries = (match.seriesTicker || kalshiEventTicker?.split('-')[0] || kTicker.split('-')[0]).toLowerCase();
  const kalshiUrl = sourcePlatform === 'kalshi'
    ? normalizeFetchUrl(inputUrl)
    : `https://kalshi.com/markets/${kSeries}/${kSlug}`;

  const polyUrl = sourcePlatform === 'polymarket'
    ? normalizeFetchUrl(inputUrl)
    : `https://polymarket.com/event/${polySlug}`;

  return {
    kalshiUrl,
    kalshiTicker: kalshiMarket?.ticker || kTicker,
    polyUrl,
    kalshiTitle: kalshiMarket?.title || sourceTitle,
    kalshiYesSub: kalshiMarket?.yesSub,
    kalshiNoSub: kalshiMarket?.noSub,
    polyTitle: polyMarket?.question || (sourcePlatform === 'polymarket' ? sourceTitle : match.title),
    polyOutcomes: polyMarket?.outcomes,
    label: result.label,
  };
}

/* ── Register routes ────────────────────────────────────────── */

export function registerArbitrageRoutes(app, { getClobClient } = {}) {
  if (!pool) {
    console.warn('[arb] Postgres not configured (set ARB_DATABASE_URL or DB_*). Arb API disabled.');
    app.post('/api/arb/start', (req, res) => res.status(503).json({ error: 'Database not configured' }));
    app.post('/api/arb/stop/:id', (req, res) => res.status(503).json({ error: 'Database not configured' }));
    app.get('/api/arb/session/:id', (req, res) => res.status(503).json({ error: 'Database not configured' }));
    app.get('/api/arb/sessions', (req, res) => res.status(503).json({ error: 'Database not configured' }));
    return;
  }

  async function insertTick(row) {
    await pool.query(
      `INSERT INTO arb_ticks (session_id, unix_s, external_price, external_no_price, poly_up, poly_down, poly_pair_cost, cross_cost, cross_edge, is_arbitrage, error_external, error_poly)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        row.session_id, row.unix_s, row.external_price, row.external_no_price,
        row.poly_up, row.poly_down, row.poly_pair_cost, row.cross_cost,
        row.cross_edge, row.is_arbitrage, row.error_external, row.error_poly,
      ],
    );
  }

  async function writeTick(sessionId, fee, kalshiCache, polyCache) {
    const unix = Math.floor(Date.now() / 1000);

    // Kalshi: try WS cache first, fall back to REST
    let extPrice = null;
    let extNo = null;
    let errExt = null;

    // Use kalshiCache (updated by book cache every 1s) — no separate REST poll
    if (kalshiCache.yesBid != null) {
      extPrice = kalshiCache.yesAsk != null ? (kalshiCache.yesBid + kalshiCache.yesAsk) / 2 : kalshiCache.yesBid;
      extNo = kalshiCache.noAsk != null ? (kalshiCache.noBid + kalshiCache.noAsk) / 2 : 1 - extPrice;
    } else if (kalshiCache.ticker) {
      errExt = 'Waiting for book data...';
    } else {
      errExt = kalshiCache.error || 'No Kalshi data';
    }

    // Poly prices from WS cache; REST fallback if stale >5s
    let polyUp = polyCache.up ?? null;
    let polyDown = polyCache.down ?? null;
    const polyStale = !polyCache.updated || (Date.now() - polyCache.updated > 5000);
    if (polyStale && polyCache.tokens?.length >= 2) {
      try {
        const [upP, downP] = await Promise.all(
          polyCache.tokens.map(tid =>
            fetch(`https://clob.polymarket.com/price?token_id=${encodeURIComponent(tid)}&side=sell`)
              .then(r => r.json()).then(d => parseFloat(d.price)).catch(() => null)
          ),
        );
        if (upP != null) { polyUp = upP; polyCache.up = upP; }
        if (downP != null) { polyDown = downP; polyCache.down = downP; }
        polyCache.updated = Date.now();
      } catch {}
    }
    const errPoly = (polyUp == null && polyDown == null) ? (polyCache.error || 'No Poly WS data yet') : null;

    const polyPair = polyUp != null && polyDown != null ? polyUp + polyDown : null;
    const crossCost = extPrice != null && polyDown != null ? extPrice + polyDown : null;
    const crossEdge = crossCost != null ? 1 - fee - crossCost : null;
    const isArb = crossEdge != null && crossEdge > 0;

    insertTick({
      session_id: sessionId,
      unix_s: unix,
      external_price: extPrice,
      external_no_price: extNo,
      poly_up: polyUp,
      poly_down: polyDown,
      poly_pair_cost: polyPair,
      cross_cost: crossCost,
      cross_edge: crossEdge,
      is_arbitrage: isArb,
      error_external: errExt,
      error_poly: errPoly,
    }).catch(e => console.error('[arb] tick insert error:', e.message));
  }

  app.post('/api/arb/start', async (req, res) => {
    try {
      const { externalUrl, polymarketSlug, externalSelector, label, feeThreshold } = req.body || {};
      if (!externalUrl || !polymarketSlug) {
        return res.status(400).json({ error: 'externalUrl and polymarketSlug required' });
      }
      const fee = Math.min(0.5, Math.max(0, parseFloat(feeThreshold) || 0.02));
      let extUrl = normalizeFetchUrl(String(externalUrl).trim());
      let polyRaw = normalizeFetchUrl(String(polymarketSlug).trim());

      if (looksPolymarketUrl(extUrl) && !extractKalshiTicker(extUrl)) {
        if (looksKalshiInput(polyRaw)) {
          [extUrl, polyRaw] = [polyRaw, extUrl];
        } else {
          return res.status(400).json({
            error:
              'First field is Kalshi only. Second field is Polymarket. You pasted Polymarket in the Kalshi field.',
          });
        }
      }

      const polySlug = extractPolymarketSlug(polyRaw);

      // Resolve both sides in parallel
      const [kalshiResult, polyResult] = await Promise.all([
        resolveKalshiTicker(extUrl),
        resolvePolyTokens(polySlug),
      ]);

      const kalshiTicker = kalshiResult.ticker;
      const polyTokens = polyResult.tokens;

      // Resolve ALL Kalshi markets in this event (for 2-market events like NBA/NHL)
      let allKalshiMarkets = [];
      if (kalshiTicker) {
        const eventTicker = kalshiTicker.replace(/-[A-Z]+$/i, ''); // strip market suffix to get event
        try {
          const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=10`);
          const md = await mr.json();
          allKalshiMarkets = (md.markets || []).map(m => ({
            ticker: m.ticker,
            title: m.title,
            yesSub: m.yes_sub_title,
            yesBid: parseFloat(m.yes_bid_dollars) || null,
            yesAsk: parseFloat(m.yes_ask_dollars) || null,
            noBid: parseFloat(m.no_bid_dollars) || null,
            noAsk: parseFloat(m.no_ask_dollars) || null,
          }));
        } catch {}
      }

      // Create session
      const ins = await pool.query(
        `INSERT INTO arb_sessions (label, external_url, external_selector, polymarket_slug, fee_threshold)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [label || null, extUrl, externalSelector ? String(externalSelector).trim() : null, polySlug, fee],
      );
      const session = ins.rows[0];
      const id = session.id;

      // Seed caches with initial REST data
      const kalshiCache = {
        ticker: kalshiTicker, wsConnected: false,
        yesBid: null, yesAsk: null, noBid: null, noAsk: null, last: null,
        updated: 0, error: kalshiResult.initial?.error || null,
      };
      if (kalshiResult.initial?.price != null) {
        const raw = kalshiResult.initial.raw || {};
        kalshiCache.yesBid = parseFloat(raw.yes_bid_dollars) || null;
        kalshiCache.yesAsk = parseFloat(raw.yes_ask_dollars) || null;
        kalshiCache.noBid = parseFloat(raw.no_bid_dollars) || null;
        kalshiCache.noAsk = parseFloat(raw.no_ask_dollars) || null;
        kalshiCache.last = parseFloat(raw.last_price_dollars) || null;
        kalshiCache.updated = Date.now();
      }

      const polyCache = {
        up: polyResult.up ?? null,
        down: polyResult.down ?? null,
        tokens: polyTokens || [],
        updated: polyResult.up != null ? Date.now() : 0,
        error: polyResult.error || null,
      };

      // Connect websockets
      let kalshiWs = null;
      if (kalshiTicker) {
        kalshiWs = connectKalshiWs(kalshiTicker, kalshiCache, id.slice(0, 8));
      }

      let polyWs = null;
      if (polyTokens?.length) {
        polyWs = connectPolyWs(polyTokens, polyCache, id.slice(0, 8));
      }

      // Write first tick immediately
      writeTick(id, fee, kalshiCache, polyCache);

      // 500ms interval reads from WS caches
      const iv = setInterval(() => writeTick(id, fee, kalshiCache, polyCache), 500);

      // 2s background book cache updater (Kalshi rate limit is ~10 req/s)
      const bookCache = { data: null, updated: 0 };
      const allTickers = allKalshiMarkets.length > 1 ? allKalshiMarkets.map(m => m.ticker) : [kalshiTicker];
      const bookIv = setInterval(async () => {
        try {
          // Kalshi: market + orderbook for primary, market only for others — 1 per second
          const [mktRes, obRes] = await Promise.all([
            kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(kalshiTicker)}`).catch(() => null),
            kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(kalshiTicker)}/orderbook`).catch(() => null),
          ]);

          // For multi-market: fetch other tickers (just market data, no orderbook)
          let allKalshiBook = [];
          if (allTickers.length > 1) {
            const fetches = await Promise.all(allTickers.map(t =>
              kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(t)}`).then(r => r.ok ? r.json() : null).catch(() => null)
            ));
            allKalshiBook = fetches.filter(Boolean).map(d => {
              const m = d.market;
              return m ? {
                ticker: m.ticker, title: m.title, yesSub: m.yes_sub_title, noSub: m.no_sub_title,
                yesBid: parseFloat(m.yes_bid_dollars) || null, yesAsk: parseFloat(m.yes_ask_dollars) || null,
                noBid: parseFloat(m.no_bid_dollars) || null, noAsk: parseFloat(m.no_ask_dollars) || null,
              } : null;
            }).filter(Boolean);
          }

          let ksYesAsk = null, ksNoAsk = null, ksYesBid = null, ksNoBid = null;
          let ksYesAskQty = null, ksNoAskQty = null, ksYesBidQty = null, ksNoBidQty = null;

          if (obRes?.ok) {
            const ob = await obRes.json();
            const fp = ob.orderbook_fp || ob;
            const yesDollars = fp.yes_dollars || [];
            const noDollars = fp.no_dollars || [];
            if (yesDollars.length) {
              const sorted = yesDollars.map(l => ({ price: parseFloat(l[0]), qty: parseFloat(l[1]) })).sort((a, b) => b.price - a.price);
              if (sorted[0]?.price > 0) { ksYesBid = sorted[0].price; ksYesBidQty = sorted[0].qty; ksNoAsk = 1 - sorted[0].price; ksNoAskQty = sorted[0].qty; }
            }
            if (noDollars.length) {
              const sorted = noDollars.map(l => ({ price: parseFloat(l[0]), qty: parseFloat(l[1]) })).sort((a, b) => b.price - a.price);
              if (sorted[0]?.price > 0) { ksNoBid = sorted[0].price; ksNoBidQty = sorted[0].qty; ksYesAsk = 1 - sorted[0].price; ksYesAskQty = sorted[0].qty; }
            }
          }

          let ksExpiration = null;
          if (mktRes?.ok) {
            const md = (await mktRes.json()).market;
            if (md) {
              ksExpiration = md.expiration_time || md.close_time || null;
              const ya = parseFloat(md.yes_ask_dollars); const na = parseFloat(md.no_ask_dollars);
              const yb = parseFloat(md.yes_bid_dollars); const nb = parseFloat(md.no_bid_dollars);
              if (!Number.isNaN(ya) && ya > 0 && ksYesAsk == null) ksYesAsk = ya;
              if (!Number.isNaN(na) && na > 0 && ksNoAsk == null) ksNoAsk = na;
              if (!Number.isNaN(yb) && yb > 0 && ksYesBid == null) ksYesBid = yb;
              if (!Number.isNaN(nb) && nb > 0 && ksNoBid == null) ksNoBid = nb;
            }
          }

          // Poly book
          let polyBook = { up: null, down: null };
          if (polyTokens?.length >= 2) {
            const [upBook, downBook] = await Promise.all(
              polyTokens.map(tid =>
                fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tid)}`)
                  .then(r => r.json()).catch(() => null)
              ),
            );
            for (const [book, key] of [[upBook, 'up'], [downBook, 'down']]) {
              if (book?.asks?.length) {
                const asks = book.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
                const bids = (book.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
                polyBook[key] = {
                  bestAsk: parseFloat(asks[0].price), bestAskQty: parseFloat(asks[0].size),
                  bestBid: bids[0] ? parseFloat(bids[0].price) : null, bestBidQty: bids[0] ? parseFloat(bids[0].size) : null,
                  depthAt1c: asks.filter(l => parseFloat(l.price) <= parseFloat(asks[0].price) + 0.01).reduce((s, l) => s + parseFloat(l.size), 0),
                };
              }
            }
          }

          // Update kalshiCache so tick writer uses fresh prices
          if (ksYesBid != null) kalshiCache.yesBid = ksYesBid;
          if (ksYesAsk != null) kalshiCache.yesAsk = ksYesAsk;
          if (ksNoBid != null) kalshiCache.noBid = ksNoBid;
          if (ksNoAsk != null) kalshiCache.noAsk = ksNoAsk;
          kalshiCache.updated = Date.now();

          bookCache.data = {
            kalshi: { yesAsk: ksYesAsk, yesAskQty: ksYesAskQty, yesBid: ksYesBid, yesBidQty: ksYesBidQty, noAsk: ksNoAsk, noAskQty: ksNoAskQty, noBid: ksNoBid, noBidQty: ksNoBidQty, expiration: ksExpiration },
            allKalshi: allKalshiBook.length > 1 ? allKalshiBook : undefined,
            poly: polyBook,
            updated: { kalshi: Date.now(), poly: Date.now() },
          };
          bookCache.updated = Date.now();
        } catch {}
      }, 2000); // 2s — multiple campaigns share the rate limit

      sessions.set(id, {
        interval: iv, bookInterval: bookIv, bookCache, kalshiWs, polyWs, kalshiCache, polyCache,
        kalshiTicker, allKalshiMarkets, polyTokens: polyTokens || [],
        polyOutcomes: polyResult.outcomes || ['Up', 'Down'],
        negRisk: polyResult.negRisk || false,
        tickSize: '0.01',
        fee,
      });

      res.json({
        session,
        meta: {
          kalshiTicker,
          allKalshiMarkets,
          kalshiTitle: kalshiResult.initial?.raw?.title || kalshiTicker,
          polyTitle: polyResult.question || polySlug,
          polyOutcomes: polyResult.outcomes || ['Up', 'Down'],
        },
      });
    } catch (e) {
      console.error('[arb] start', e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  app.post('/api/arb/stop/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const s = sessions.get(id);
      if (s) {
        clearInterval(s.interval);
        if (s.bookInterval) clearInterval(s.bookInterval);
        s.kalshiWs?.close();
        s.polyWs?.close();
        sessions.delete(id);
      }
      await pool.query('UPDATE arb_sessions SET ended_at = NOW() WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/arb/session/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const lim = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 600));
      const s = await pool.query('SELECT * FROM arb_sessions WHERE id = $1', [id]);
      const ticks = await pool.query(
        'SELECT * FROM arb_ticks WHERE session_id = $1 ORDER BY unix_s DESC LIMIT $2',
        [id, lim],
      );
      res.json({ session: s.rows[0] || null, ticks: ticks.rows.reverse() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/arb/sessions', async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM arb_sessions ORDER BY created_at DESC LIMIT 50');
      res.json({ sessions: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Live book depth for a running session — used to show fill probability. */
  /** Book endpoint — returns cached data instantly (background updates every 200ms). */
  app.get('/api/arb/book/:id', (req, res) => {
    try {
      const sess = sessions.get(req.params.id);
      if (!sess) return res.status(404).json({ error: 'Session not running' });
      if (sess.bookCache?.data) return res.json(sess.bookCache.data);
      return res.json({ kalshi: {}, poly: {}, updated: {} });
      /* Old REST-per-request code removed — now using background bookCache */
      /*
      if (kalshiTicker) {
        try {
          const [obRes, mktRes] = await Promise.all([
            kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(kalshiTicker)}/orderbook`),
            kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(kalshiTicker)}`),
          ]);

          // Parse orderbook: arrays of ["price_dollars", "qty"]
          if (obRes.ok) {
            const ob = await obRes.json();
            const fp = ob.orderbook_fp || ob.orderbook || ob;
            const yesDollars = fp.yes_dollars || [];
            const noDollars = fp.no_dollars || [];

            if (yesDollars.length) {
              const sorted = yesDollars.map(l => ({ price: parseFloat(l[0]), qty: parseFloat(l[1]) })).sort((a, b) => b.price - a.price);
              // Best YES bid
              if (sorted[0]?.price > 0) {
                ksYesBid = sorted[0].price;
                ksYesBidQty = sorted[0].qty;
                // To BUY NO at ask = 1 - best YES bid
                ksNoAsk = 1 - sorted[0].price;
                ksNoAskQty = sorted[0].qty;
              }
            }
            if (noDollars.length) {
              const sorted = noDollars.map(l => ({ price: parseFloat(l[0]), qty: parseFloat(l[1]) })).sort((a, b) => b.price - a.price);
              // Best NO bid
              if (sorted[0]?.price > 0) {
                ksNoBid = sorted[0].price;
                ksNoBidQty = sorted[0].qty;
                // To BUY YES at ask = 1 - best NO bid
                ksYesAsk = 1 - sorted[0].price;
                ksYesAskQty = sorted[0].qty;
              }
            }
          }

          // Fallback: market endpoint for ask prices if orderbook was empty
          if (mktRes.ok && (ksYesAsk == null || ksNoAsk == null)) {
            const md = (await mktRes.json()).market;
            if (md) {
              const yAsk = parseFloat(md.yes_ask_dollars);
              const nAsk = parseFloat(md.no_ask_dollars);
              if (!Number.isNaN(yAsk) && yAsk > 0 && ksYesAsk == null) ksYesAsk = yAsk;
              if (!Number.isNaN(nAsk) && nAsk > 0 && ksNoAsk == null) ksNoAsk = nAsk;
            }
          }
        } catch {}
      }

      // Polymarket: fetch order book via REST for depth
      let polyBook = { up: null, down: null };
      if (polyTokens?.length >= 2) {
        const [upBook, downBook] = await Promise.all(
          polyTokens.map(tid =>
            fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tid)}`)
              .then(r => r.json())
              .catch(() => null)
          ),
        );
        // asks = what we can buy at (sorted low to high)
        if (upBook?.asks?.length) {
          const asks = upBook.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
          const bestAsk = asks[0];
          const bids = (upBook.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
          const bestBid = bids[0];
          polyBook.up = {
            bestAsk: parseFloat(bestAsk.price),
            bestAskQty: parseFloat(bestAsk.size),
            bestBid: bestBid ? parseFloat(bestBid.price) : null,
            bestBidQty: bestBid ? parseFloat(bestBid.size) : null,
            depthAt1c: asks
              .filter(l => parseFloat(l.price) <= parseFloat(bestAsk.price) + 0.01)
              .reduce((s, l) => s + parseFloat(l.size), 0),
          };
        }
        if (downBook?.asks?.length) {
          const asks = downBook.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
          const bestAsk = asks[0];
          const bids = (downBook.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
          const bestBid = bids[0];
          polyBook.down = {
            bestAsk: parseFloat(bestAsk.price),
            bestAskQty: parseFloat(bestAsk.size),
            bestBid: bestBid ? parseFloat(bestBid.price) : null,
            bestBidQty: bestBid ? parseFloat(bestBid.size) : null,
            depthAt1c: asks
              .filter(l => parseFloat(l.price) <= parseFloat(bestAsk.price) + 0.01)
              .reduce((s, l) => s + parseFloat(l.size), 0),
          };
        }
      }

      res.json({
        kalshi: {
          yesAsk: ksYesAsk, yesAskQty: ksYesAskQty,
          yesBid: ksYesBid, yesBidQty: ksYesBidQty,
          noAsk: ksNoAsk, noAskQty: ksNoAskQty,
          noBid: ksNoBid, noBidQty: ksNoBidQty,
        },
      */
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Update a running session's poly tokens (when user picks a different market via "change") */
  app.post('/api/arb/session/:id/update-poly', async (req, res) => {
    try {
      const sess = sessions.get(req.params.id);
      if (!sess) return res.status(404).json({ error: 'Session not found' });
      const { tokenIds, outcomes } = req.body || {};
      if (!tokenIds?.length) return res.status(400).json({ error: 'tokenIds required' });

      // Update session tokens
      sess.polyTokens = tokenIds;
      sess.polyOutcomes = outcomes || sess.polyOutcomes;

      // Reconnect poly WS with new tokens
      if (sess.polyWs) { try { sess.polyWs.close(); } catch {} }
      sess.polyCache.up = null;
      sess.polyCache.down = null;
      sess.polyCache.tokens = tokenIds;
      sess.polyCache.updated = 0;
      sess.polyWs = connectPolyWs(tokenIds, sess.polyCache, req.params.id.slice(0, 8));

      console.log(`[arb] Session ${req.params.id.slice(0,8)} poly tokens updated: ${tokenIds[0]?.slice(0,12)}...`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Return current BTC 15m defaults for both platforms, including labels/metadata. */
  app.get('/api/arb/defaults/btc15m', async (req, res) => {
    try {
      // Current Polymarket slot
      const now = Math.floor(Date.now() / 1000);
      const slot = Math.floor(now / 900) * 900;
      const polySlug = `btc-updown-15m-${slot}`;
      const polyUrl = `https://polymarket.com/event/${polySlug}`;

      // Fetch Polymarket metadata (question + outcomes)
      let polyMeta = { question: null, outcomes: null };
      try {
        const pRes = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(polySlug)}`);
        const pArr = await pRes.json();
        const pm = pArr?.[0]?.markets?.[0];
        if (pm) {
          polyMeta.question = pm.question || pm.groupItemTitle || null;
          polyMeta.outcomes = typeof pm.outcomes === 'string' ? JSON.parse(pm.outcomes) : pm.outcomes;
        }
      } catch {}

      // Kalshi: query for current open BTC 15m event
      const kRes = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=KXBTC15M&limit=1&status=open`);
      const kData = await kRes.json();
      const event = kData?.events?.[0];
      const eventTicker = event?.event_ticker;

      let kalshiUrl = '';
      let marketTicker = null;
      let kalshiMeta = { title: null, subtitle: null, yesSubtitle: null, noSubtitle: null };
      if (eventTicker) {
        // Resolve to market ticker + grab title
        const mRes = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=5`);
        const mData = await mRes.json();
        const firstMarket = mData?.markets?.[0];
        marketTicker = firstMarket?.ticker || null;
        if (firstMarket) {
          kalshiMeta.title = firstMarket.title || null;
          kalshiMeta.subtitle = firstMarket.subtitle || null;
          kalshiMeta.yesSubtitle = firstMarket.yes_sub_title || null;
          kalshiMeta.noSubtitle = firstMarket.no_sub_title || null;
        }
        const slug = (marketTicker || eventTicker).toLowerCase();
        kalshiUrl = `https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/${slug}`;
      }

      // Also include event-level title if available
      if (event?.title) kalshiMeta.eventTitle = event.title;

      res.json({
        kalshi: kalshiUrl, poly: polyUrl, eventTicker, marketTicker,
        kalshiMeta, polyMeta,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ── Execute arb: place orders on BOTH platforms ──────────── */

  async function placeKalshiOrder(ticker, side, count, priceCents) {
    // side: 'yes' or 'no', priceCents: integer 1-99
    const body = {
      ticker,
      action: 'buy',
      side,
      type: 'limit',
      count,
    };
    // Use dollar-denominated fields to avoid cents ambiguity
    const priceDollars = (priceCents / 100).toFixed(2);
    if (side === 'yes') body.yes_price_dollars = priceDollars;
    else body.no_price_dollars = priceDollars;

    console.log(`[arb-execute] Kalshi order:`, JSON.stringify(body));
    const res = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    console.log(`[arb-execute] Kalshi response: ${res.status}`, text.slice(0, 300));
    if (!res.ok) throw new Error(`Kalshi ${res.status}: ${data?.error?.message || data?.message || text.slice(0, 200)}`);
    return data;
  }

  app.post('/api/arb/execute', async (req, res) => {
    try {
      const { sessionId, strategy, swapPoly, marketOrder } = req.body || {};
      // strategy: 'A' = buy KS YES + Poly Down, 'B' = buy KS NO + Poly Up
      if (!sessionId || !['A', 'B'].includes(strategy)) {
        return res.status(400).json({ error: 'sessionId and strategy (A or B) required' });
      }

      const sess = sessions.get(sessionId);
      if (!sess) return res.status(404).json({ error: 'Session not found or stopped' });

      const { kalshiCache, polyCache, kalshiTicker, polyTokens, negRisk, tickSize, fee: FEE } = sess;
      if (!kalshiTicker) return res.status(400).json({ error: 'No Kalshi ticker resolved for this session' });
      if (!polyTokens?.length) return res.status(400).json({ error: 'No Polymarket tokens resolved for this session' });
      if (!hasKalshiAuth()) return res.status(400).json({ error: 'Kalshi auth not configured — set KALSHI_API_KEY + KALSHI_PRIVATE_KEY_PATH in .env' });

      const clob = getClobClient?.();
      if (!clob) return res.status(500).json({ error: 'Polymarket CLOB client not ready' });

      const SHARES = 5;
      const tick = parseFloat(tickSize) || 0.01;

      let kalshiSide, kalshiPriceCents, polyTokenId, polyPrice;

      // Fetch real ask prices from Poly book for exact limit prices
      let polyBookAsks = {};
      if (polyTokens?.length >= 2) {
        const [upBook, downBook] = await Promise.all(
          polyTokens.map(tid =>
            fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tid)}`)
              .then(r => r.json()).catch(() => null)
          ),
        );
        if (upBook?.asks?.length) {
          const best = upBook.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price))[0];
          polyBookAsks.up = parseFloat(best.price);
        }
        if (downBook?.asks?.length) {
          const best = downBook.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price))[0];
          polyBookAsks.down = parseFloat(best.price);
        }
      }

      // Fetch real Kalshi ask from market endpoint
      let ksMarketAsk = {};
      try {
        const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(kalshiTicker)}`);
        if (mr.ok) {
          const md = await mr.json();
          const m = md.market;
          if (m) {
            const ya = parseFloat(m.yes_ask_dollars);
            const na = parseFloat(m.no_ask_dollars);
            if (!Number.isNaN(ya) && ya > 0) ksMarketAsk.yes = Math.round(ya * 100);
            if (!Number.isNaN(na) && na > 0) ksMarketAsk.no = Math.round(na * 100);
          }
        }
      } catch {}

      // Token mapping: default YES+Down(token1), NO+Up(token0). Swap inverts the poly side.
      const polyDownIdx = swapPoly ? 0 : 1;
      const polyUpIdx = swapPoly ? 1 : 0;

      if (strategy === 'A') {
        // Buy Kalshi YES + Poly opposite side
        const ksYesAsk = ksMarketAsk.yes ?? (kalshiCache.yesAsk != null ? Math.round(kalshiCache.yesAsk * 100) : null);
        const pAsk = swapPoly ? (polyBookAsks.up ?? polyCache.up) : (polyBookAsks.down ?? polyCache.down);
        if (ksYesAsk == null) return res.status(400).json({ error: 'No Kalshi YES ask price available' });
        if (pAsk == null) return res.status(400).json({ error: 'No Poly ask price available' });

        kalshiSide = 'yes';
        kalshiPriceCents = marketOrder ? 99 : ksYesAsk;
        polyTokenId = polyTokens[polyDownIdx];
        polyPrice = marketOrder ? 0.99 : pAsk;
      } else {
        // Buy Kalshi NO + Poly opposite side
        const ksNoAsk = ksMarketAsk.no ?? (kalshiCache.noAsk != null ? Math.round(kalshiCache.noAsk * 100) : null);
        const pAsk = swapPoly ? (polyBookAsks.down ?? polyCache.down) : (polyBookAsks.up ?? polyCache.up);
        if (marketOrder) {
          // Skip price checks for market orders
        } else {
          if (ksNoAsk == null) return res.status(400).json({ error: 'No Kalshi NO ask price available' });
          if (pAsk == null) return res.status(400).json({ error: 'No Poly ask price available' });
        }

        kalshiSide = 'no';
        kalshiPriceCents = marketOrder ? 99 : (ksNoAsk || 50);
        polyTokenId = polyTokens[polyUpIdx];
        polyPrice = marketOrder ? 0.99 : (pAsk || 0.50);
      }

      // Pre-check: verify Kalshi market is open for trading
      try {
        const checkR = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(kalshiTicker)}`);
        if (checkR.ok) {
          const checkD = await checkR.json();
          const mktStatus = checkD.market?.status;
          if (mktStatus && mktStatus !== 'active' && mktStatus !== 'open') {
            return res.status(400).json({ error: `Kalshi market is ${mktStatus} — trading suspended` });
          }
          // Check if can_close_early or similar flags indicate trading is locked
          if (checkD.market?.close_time) {
            const closeTime = new Date(checkD.market.close_time).getTime();
            if (closeTime < Date.now()) {
              return res.status(400).json({ error: 'Kalshi market trading window has closed' });
            }
          }
        }
      } catch {}

      // Log combined cost (no block — manual button, user sees prices)
      const combinedCost = kalshiPriceCents + Math.round(polyPrice * 100);
      console.log(`[arb-execute] Manual: KS ${kalshiSide} ${kalshiPriceCents}¢ + Poly ${Math.round(polyPrice * 100)}¢ = ${combinedCost}¢`);

      // SAFETY CHECK: verify book depth — need 5+ shares at the ask within profitable range
      const sess2 = sessions.get(sessionId);
      if (sess2?.bookCache?.data && !marketOrder) {
        const bk = sess2.bookCache.data;
        const ksAskQty = kalshiSide === 'yes' ? bk.kalshi?.yesAskQty : bk.kalshi?.noAskQty;
        const polyAskQty = strategy === 'A'
          ? (swapPoly ? bk.poly?.up?.bestAskQty : bk.poly?.down?.bestAskQty)
          : (swapPoly ? bk.poly?.down?.bestAskQty : bk.poly?.up?.bestAskQty);

        const MIN_DEPTH = 20; // need 20+ shares at the ask
        if (ksAskQty != null && ksAskQty < MIN_DEPTH) {
          return res.status(400).json({ error: `Kalshi ${kalshiSide} book too thin: ${ksAskQty} avail, need ${MIN_DEPTH}` });
        }
        if (polyAskQty != null && polyAskQty < MIN_DEPTH) {
          return res.status(400).json({ error: `Poly book too thin: ${polyAskQty} avail, need ${MIN_DEPTH}` });
        }
      }

      console.log(`[arb-execute] Strategy ${strategy}: Kalshi ${kalshiSide.toUpperCase()} ${SHARES}@${kalshiPriceCents}¢ + Poly ${Math.round(polyPrice * 100)}¢ = ${combinedCost}¢`);

      // Fire both orders in parallel
      const [kalshiResult, polyResult] = await Promise.allSettled([
        placeKalshiOrder(kalshiTicker, kalshiSide, SHARES, kalshiPriceCents),
        (async () => {
          console.log(`[arb-execute] Poly order: tokenID=${polyTokenId?.slice(0,12)}... price=${polyPrice} size=${SHARES} tickSize=${tickSize} negRisk=${negRisk}`);
          const signed = await clob.createOrder({
            tokenID: polyTokenId,
            price: polyPrice,
            size: SHARES,
            side: 'BUY',
          }, { tickSize, negRisk });
          const result = await clob.postOrder(signed, 'GTC');
          console.log(`[arb-execute] Poly result:`, JSON.stringify(result).slice(0, 300));
          return result;
        })(),
      ]);

      const kalshiOk = kalshiResult.status === 'fulfilled';
      const polyOk = polyResult.status === 'fulfilled';

      console.log(`[arb-execute] Kalshi: ${kalshiOk ? 'OK ' + JSON.stringify(kalshiResult.value).slice(0, 200) : 'FAIL ' + kalshiResult.reason?.message}`);
      console.log(`[arb-execute] Poly: ${polyOk ? 'OK ' + JSON.stringify(polyResult.value).slice(0, 200) : 'FAIL ' + polyResult.reason?.message}`);

      // Extract Kalshi order details
      const kalshiOrder = kalshiOk ? kalshiResult.value?.order : null;
      const kalshiOrderId = kalshiOrder?.order_id || null;
      const kalshiFillCount = kalshiOrder ? parseFloat(kalshiOrder.fill_count_fp || '0') : 0;
      const kalshiFilled = kalshiFillCount > 0;
      // Actual fill price: taker_fill_cost / fill_count gives average fill price
      const kalshiTakerCost = kalshiOrder ? parseFloat(kalshiOrder.taker_fill_cost_dollars || '0') : 0;
      const kalshiMakerCost = kalshiOrder ? parseFloat(kalshiOrder.maker_fill_cost_dollars || '0') : 0;
      const kalshiFillCost = kalshiTakerCost + kalshiMakerCost;
      const kalshiAvgFillPrice = kalshiFillCount > 0 ? Math.round((kalshiFillCost / kalshiFillCount) * 100) : kalshiPriceCents;
      const kalshiStatus = kalshiOrder?.status || 'unknown';
      const kalshiRemaining = kalshiOrder ? parseFloat(kalshiOrder.remaining_count_fp || '0') : 0;

      // Extract Poly order details
      const polyOrderId = polyOk ? (polyResult.value?.orderID || polyResult.value?.id || null) : null;
      const polyStatus = polyOk ? (polyResult.value?.status || 'sent') : 'failed';
      const polyMatched = polyStatus === 'matched'; // Only "matched" means actually filled
      const polyMakingAmt = polyOk ? parseFloat(polyResult.value?.makingAmount || '0') : 0;
      const polyTakingAmt = polyOk ? parseFloat(polyResult.value?.takingAmount || '0') : 0;
      const polyFilled = polyMatched && polyTakingAmt > 0;

      if (polyOk && !polyFilled) {
        console.log(`[arb-execute] WARNING: Poly order ${polyStatus} but NOT matched (takingAmt=${polyTakingAmt}). Order is resting, not filled!`);
      }

      // Log to database with REAL fill prices
      const polySide = strategy === 'A' ? 'down' : 'up';
      const kalshiRealPrice = kalshiFillCount > 0 ? kalshiFillCost / kalshiFillCount : kalshiPriceCents / 100;
      const polyActualCost = polyTakingAmt > 0 && polyMakingAmt > 0 ? polyMakingAmt / polyTakingAmt : polyPrice;
      const realTotalCost = (kalshiRealPrice + polyActualCost) * SHARES;
      const expectedPayout = 1 * SHARES;
      const kalshiFees = parseFloat(kalshiOrder?.taker_fees_dollars || '0') + parseFloat(kalshiOrder?.maker_fees_dollars || '0');
      const realProfit = expectedPayout - kalshiFees - realTotalCost;

      console.log(`[arb-execute] FILL PRICES: Kalshi ${(kalshiRealPrice*100).toFixed(1)}¢ (limit ${kalshiPriceCents}¢) | Poly ${(polyActualCost*100).toFixed(1)}¢ (limit ${(polyPrice*100).toFixed(0)}¢) | Total cost: $${realTotalCost.toFixed(2)} | Fees: $${kalshiFees.toFixed(2)} | Profit: $${realProfit.toFixed(2)}`);

      pool.query(
        `INSERT INTO arb_trades (session_id, strategy, kalshi_ticker, kalshi_side, kalshi_limit_cents, kalshi_filled, kalshi_fill_price, kalshi_shares, kalshi_order_id, kalshi_error, poly_token_id, poly_side, poly_limit_price, poly_filled, poly_fill_price, poly_shares, poly_order_id, poly_error, both_filled, total_cost, expected_payout, expected_profit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          sessionId, strategy, kalshiTicker, kalshiSide, kalshiPriceCents,
          kalshiOk && kalshiFilled, kalshiRealPrice, SHARES, kalshiOrderId,
          kalshiOk ? null : kalshiResult.reason?.message,
          polyTokenId, polySide, polyPrice,
          polyOk, polyActualCost, SHARES, polyOrderId,
          polyOk ? null : polyResult.reason?.message,
          kalshiFilled && polyFilled, realTotalCost, expectedPayout, realProfit,
        ],
      ).catch(e => console.error('[arb-execute] DB log error:', e.message));

      const response = {
        success: kalshiFilled && polyFilled,
        kalshi: {
          ok: kalshiOk,
          filled: kalshiFilled,
          side: kalshiSide,
          limitPrice: kalshiPriceCents,
          avgFillPrice: kalshiAvgFillPrice,
          shares: SHARES,
          fillCount: kalshiFillCount,
          remaining: kalshiRemaining,
          status: kalshiStatus,
          orderId: kalshiOrderId,
          error: kalshiOk ? null : kalshiResult.reason?.message,
        },
        poly: {
          ok: polyOk,
          side: polySide,
          limitPrice: polyPrice,
          avgFillPrice: polyActualCost,
          shares: SHARES,
          fillCount: polyTakingAmt || SHARES,
          status: polyStatus,
          orderId: polyOrderId,
          error: polyOk ? null : polyResult.reason?.message,
        },
      };

      console.log(`[arb-execute] RESULT: kalshi=${kalshiStatus} filled=${kalshiFillCount}/${SHARES} avg=${kalshiAvgFillPrice}¢ | poly=${polyStatus} filled=${polyFilled} taking=${polyTakingAmt} | BOTH=${kalshiFilled && polyFilled}`);

      res.json(response);
    } catch (e) {
      console.error('[arb-execute] Error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /** Paste one link → find the match on the other platform via DeepSeek. */
  app.post('/api/arb/find-match', async (req, res) => {
    try {
      const { url, kalshiMarketIdx, polyMarketIdx } = req.body || {};
      if (!url?.trim()) return res.status(400).json({ error: 'url required' });
      if (!DEEPSEEK_KEY) return res.status(503).json({ error: 'DEEPSEEK_API_KEY not set' });
      const result = await findMatchForLink(url.trim());
      res.json(result);
    } catch (e) {
      console.error('[arb] find-match error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /** Resolve a link and return ALL available markets on both platforms for user selection. */
  app.post('/api/arb/resolve-markets', async (req, res) => {
    try {
      const { url, skipAiMatch } = req.body || {};
      if (!url?.trim()) return res.status(400).json({ error: 'url required' });

      const s = url.trim();
      const isKalshi = looksKalshiInput(s);
      const isPoly = looksPolymarketUrl(s);
      if (!isKalshi && !isPoly) return res.status(400).json({ error: 'Link must be from Kalshi or Polymarket' });

      let kalshiMarkets = [];
      let polyMarkets = [];
      let eventTitle = '';

      // Resolve source platform markets
      if (isKalshi) {
        const ticker = extractKalshiTicker(s);
        if (ticker) {
          let eventTicker = ticker;
          try {
            const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(ticker)}`);
            if (mr.ok) {
              const md = await mr.json();
              eventTicker = md.market?.event_ticker || ticker;
              eventTitle = md.market?.title || ticker;
            }
          } catch {}
          try {
            const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=50`);
            const md = await mr.json();
            kalshiMarkets = (md.markets || []).map(m => ({
              ticker: m.ticker,
              title: m.title,
              yesSub: m.yes_sub_title,
              noSub: m.no_sub_title,
              yesBid: m.yes_bid_dollars,
              yesAsk: m.yes_ask_dollars,
              noBid: m.no_bid_dollars,
              noAsk: m.no_ask_dollars,
            }));
          } catch {}
        }
      }

      if (isPoly) {
        const slug = extractPolymarketSlug(s);
        try {
          const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
          const arr = await r.json();
          const ev = arr?.[0] || arr;
          eventTitle = eventTitle || ev?.title || slug;
          polyMarkets = (ev?.markets || []).map(m => ({
            question: m.question,
            outcomes: typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes,
            clobTokenIds: typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds,
          }));
        } catch {}
      }

      // Also try to find the OTHER platform via AI (skip when called from "change" button)
      if (!skipAiMatch && DEEPSEEK_KEY && (kalshiMarkets.length > 0 || polyMarkets.length > 0)) {
        try {
          const match = await findMatchForLink(s);
          if (isPoly && match.kalshiTicker) {
            // We found a Kalshi event — get its markets too
            const eventTicker = match.kalshiTicker.replace(/-[A-Z]+$/, ''); // strip market suffix to get event
            try {
              const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=50`);
              const md = await mr.json();
              if (md.markets?.length) {
                kalshiMarkets = md.markets.map(m => ({
                  ticker: m.ticker,
                  title: m.title,
                  yesSub: m.yes_sub_title,
                  noSub: m.no_sub_title,
                  yesBid: m.yes_bid_dollars,
                  yesAsk: m.yes_ask_dollars,
                }));
              }
            } catch {}
          } else if (isKalshi && match.polyUrl) {
            // We found a Poly event — get its markets too
            const polySlug = extractPolymarketSlug(match.polyUrl);
            try {
              const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(polySlug)}`);
              const arr = await r.json();
              const ev = arr?.[0] || arr;
              if (ev?.markets?.length) {
                polyMarkets = ev.markets.map(m => ({
                  question: m.question,
                  outcomes: typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes,
                  clobTokenIds: typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds,
                }));
              }
            } catch {}
          }
        } catch {}
      }

      res.json({ eventTitle, kalshiMarkets, polyMarkets, source: isKalshi ? 'kalshi' : 'polymarket' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Manually save a matched event (persisted to DB). */
  app.post('/api/arb/saved-events', async (req, res) => {
    try {
      const ev = req.body;
      if (!ev?.label) return res.status(400).json({ error: 'label required' });
      await pool.query(
        `INSERT INTO arb_saved_events (label, data, saved_at) VALUES ($1, $2, NOW())
         ON CONFLICT (label) DO UPDATE SET data = $2, saved_at = NOW()`,
        [ev.label, JSON.stringify(ev)],
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Get all saved matched events. */
  app.get('/api/arb/saved-events', async (req, res) => {
    try {
      const r = await pool.query('SELECT label, data, saved_at FROM arb_saved_events ORDER BY saved_at DESC LIMIT 50');
      const events = r.rows.map(row => ({ ...row.data, label: row.label, savedAt: row.saved_at }));
      res.json({ events });
    } catch (e) {
      res.status(500).json({ error: e.message, events: [] });
    }
  });

  /** Delete a saved event. */
  app.delete('/api/arb/saved-events/:label', async (req, res) => {
    try {
      await pool.query('DELETE FROM arb_saved_events WHERE label = $1', [decodeURIComponent(req.params.label)]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Trade history for current or all sessions. */
  app.get('/api/arb/trades', async (req, res) => {
    try {
      const sid = req.query.session_id;
      const q = sid
        ? 'SELECT * FROM arb_trades WHERE session_id = $1 ORDER BY ts DESC LIMIT 50'
        : 'SELECT * FROM arb_trades ORDER BY ts DESC LIMIT 50';
      const r = await pool.query(q, sid ? [sid] : []);
      res.json({ trades: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ── Campaigns: multiple concurrent arb sessions with server-side auto-buy ── */

  const campaigns = new Map(); // campaignId → { autoInterval, cooldownUntil, ... }

  /** Start a campaign — creates session + auto-buy loop on server */
  app.post('/api/arb/campaigns', async (req, res) => {
    try {
      const { kalshiUrl, polyUrl, label, autoEnabled, autoThreshold, autoCooldown, swapPoly, recurring, earlyExit, exitThreshold } = req.body || {};
      if (!kalshiUrl || !polyUrl) return res.status(400).json({ error: 'kalshiUrl and polyUrl required' });

      const recurringType = recurring ? detectRecurringType(kalshiUrl, polyUrl) : null;
      let sessionId;

      if (recurringType) {
        // For recurring, start with current slot
        const slotResult = await startSlotSession(recurringType);
        if (!slotResult) return res.status(500).json({ error: 'Could not start slot session' });
        sessionId = slotResult.sessionId;
      } else {
        // Normal: start session with provided URLs
        const sr = await fetch(`http://localhost:${process.env.PORT || 3001}/api/arb/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ externalUrl: kalshiUrl, polymarketSlug: polyUrl, feeThreshold: 0.02 }),
        });
        const sd = await sr.json();
        if (!sr.ok) return res.status(500).json({ error: sd.error || 'Session start failed' });
        sessionId = sd.session?.id;
      }

      // Save campaign to DB
      const ins = await pool.query(
        `INSERT INTO arb_campaigns (label, kalshi_url, poly_url, kalshi_ticker, auto_enabled, auto_threshold_cents, auto_cooldown_sec, swap_poly, session_id, status, recurring, recurring_type, early_exit, exit_threshold_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10,$11,$12,$13) RETURNING *`,
        [label || null, kalshiUrl, polyUrl, null, autoEnabled || false, autoThreshold || 3, autoCooldown || 60, swapPoly || false, sessionId, recurring || false, recurringType, earlyExit || false, exitThreshold || 4],
      );
      const campaign = ins.rows[0];

      // Start server-side auto-buy if enabled
      console.log(`[arb-campaign] Created: auto=${autoEnabled} threshold=${autoThreshold} cooldown=${autoCooldown} recurring=${recurring} swap=${swapPoly}`);
      if (autoEnabled) {
        startCampaignAuto(campaign.id, sessionId, autoThreshold || 3, autoCooldown || 60, swapPoly || false, recurring || false, recurringType, earlyExit || false, exitThreshold || 4);
      }

      res.json({ campaign, sessionId });
    } catch (e) {
      console.error('[arb-campaign] create error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /** Detect recurring event type from URLs */
  function detectRecurringType(kalshiUrl, polyUrl) {
    if (/KXBTC\d+M/i.test(kalshiUrl || '') || /btc-updown-\d+m-/i.test(polyUrl || '')) return 'btc15m';
    if (/KXETH\d+M/i.test(kalshiUrl || '') || /eth-updown-\d+m-/i.test(polyUrl || '')) return 'eth15m';
    if (/KXSOL\d+M/i.test(kalshiUrl || '') || /sol-updown-\d+m-/i.test(polyUrl || '')) return 'sol15m';
    if (/KXHYPE\d+M/i.test(kalshiUrl || '') || /hype-updown-\d+m-/i.test(polyUrl || '')) return 'hype15m';
    if (/KXXRP\d+M/i.test(kalshiUrl || '') || /xrp-updown-\d+m-/i.test(polyUrl || '')) return 'xrp15m';
    if (/KXBNB\d+M/i.test(kalshiUrl || '') || /bnb-updown-\d+m-/i.test(polyUrl || '')) return 'bnb15m';
    if (/KXDOGE\d+M/i.test(kalshiUrl || '') || /doge-updown-\d+m-/i.test(polyUrl || '')) return 'doge15m';
    return null;
  }

  /** Compute current slot URLs for a recurring type */
  function getCurrentSlotUrls(recurringType) {
    const now = Math.floor(Date.now() / 1000);
    const slot = Math.floor(now / 900) * 900;
    const map = {
      btc15m: { series: 'KXBTC15M', asset: 'btc', tf: '15' },
      eth15m: { series: 'KXETH15M', asset: 'eth', tf: '15' },
      sol15m: { series: 'KXSOL15M', asset: 'sol', tf: '15' },
      hype15m: { series: 'KXHYPE15M', asset: 'hype', tf: '15' },
      xrp15m: { series: 'KXXRP15M', asset: 'xrp', tf: '15' },
      bnb15m: { series: 'KXBNB15M', asset: 'bnb', tf: '15' },
      doge15m: { series: 'KXDOGE15M', asset: 'doge', tf: '15' },
    };
    const m = map[recurringType];
    if (!m) return null;
    return {
      polyUrl: `https://polymarket.com/event/${m.asset}-updown-${m.tf}m-${slot}`,
      kalshiSeries: m.series,
      slot,
    };
  }

  /** Start a new session for the current slot, return sessionId */
  async function startSlotSession(recurringType) {
    const urls = getCurrentSlotUrls(recurringType);
    if (!urls) return null;

    // Find current Kalshi event
    try {
      const er = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=${urls.kalshiSeries}&limit=3&status=open`);
      const ed = await er.json();
      const ev = ed.events?.[0];
      if (!ev) { console.log(`[recurring] No open ${urls.kalshiSeries} event`); return null; }

      // Get market ticker — only active markets
      const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${ev.event_ticker}&limit=5`);
      const md = await mr.json();
      const mkt = (md.markets || []).find(m => m.status === 'active') || md.markets?.[0];
      if (!mkt || mkt.status === 'settled' || mkt.status === 'closed') {
        console.log(`[recurring] ${urls.kalshiSeries} market ${mkt?.ticker} is ${mkt?.status} — skipping`);
        return null;
      }
      const kalshiUrl = mkt.ticker || ev.event_ticker;

      // Start session
      const sr = await fetch(`http://localhost:${process.env.PORT || 3001}/api/arb/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ externalUrl: kalshiUrl, polymarketSlug: urls.polyUrl, feeThreshold: 0.02 }),
      });
      const sd = await sr.json();
      if (!sr.ok) { console.log(`[recurring] Session start failed:`, sd.error); return null; }
      console.log(`[recurring] Started ${recurringType} session: ${sd.session?.id?.slice(0,8)} | KS: ${kalshiUrl} | Poly slot: ${urls.slot}`);
      return { sessionId: sd.session?.id, kalshiUrl, polyUrl: urls.polyUrl, slot: urls.slot };
    } catch (e) {
      console.error(`[recurring] Error:`, e.message);
      return null;
    }
  }

  function startCampaignAuto(campaignId, sessionId, thresholdCents, cooldownSec, swapPoly, recurring, recurringType, earlyExit = false, exitThresholdCents = 4) {
    // CRITICAL: clear ANY existing interval for this campaign to prevent stacking
    const existing = campaigns.get(campaignId);
    if (existing) {
      if (existing.stop) existing.stop(); else if (existing.interval) clearInterval(existing.interval);
      campaigns.delete(campaignId);
      console.log(`[auto-campaign:${campaignId.slice(0,8)}] Stopped before restart`);
    }
    // Also guard: if already in map from a race condition, skip
    if (campaigns.has(campaignId)) {
      console.log(`[auto-campaign:${campaignId.slice(0,8)}] SKIPPED — already running`);
      return;
    }

    // Enforce minimum 30s cooldown
    cooldownSec = Math.max(30, cooldownSec);

    const state = {
      currentSessionId: sessionId, currentSlot: 0, renewLock: false,
      // Maker strategy: KS limit only, Poly FOK on fill
      pendingOrderId: null,     // Kalshi order ID currently resting
      pendingStrategy: null,    // 'A' or 'B'
      pendingKsSide: null,      // 'yes' or 'no'
      pendingKsPrice: null,     // limit price in cents
      pendingPolyTokenId: null, // which poly token to FOK when filled
      pendingPolyPrice: null,   // poly ask price at time of placement
      lock: false,
    };

    // Sequential loop — setTimeout chain, physically impossible to overlap
    let stopped = false;
    async function tick() {
      if (stopped) return;
      try {

      // ── 1s before next slot: cancel all unfilled orders ──
      if (recurring && recurringType) {
        const now = Math.floor(Date.now() / 1000);
        const nextSlot = (Math.floor(now / 900) + 1) * 900;
        const secsToNext = nextSlot - now;
        if (secsToNext <= 1 && !state.preCancelDone) {
          state.preCancelDone = true;
          console.log(`[maker:${campaignId.slice(0,8)}] ${secsToNext}s to next slot — cancelling all unfilled orders`);
          // Cancel pending KS limit
          if (state.pendingOrderId) {
            try { await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${state.pendingOrderId}`, { method: 'DELETE' }); } catch {}
            state.pendingOrderId = null;
          }
          // Cancel ALL resting KS orders for this ticker
          try {
            const sess0 = sessions.get(state.currentSessionId);
            if (sess0?.kalshiTicker) {
              const oo = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders?status=resting&limit=50`);
              const orders = (await oo.json()).orders || [];
              for (const o of orders) {
                if (o.ticker === sess0.kalshiTicker) {
                  await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${o.order_id}`, { method: 'DELETE' }).catch(() => {});
                  console.log(`[maker:${campaignId.slice(0,8)}] Cancelled resting KS order ${o.order_id.slice(0,8)}`);
                }
              }
            }
          } catch {}
          // Cancel open Poly orders
          try {
            const clob = getClobClient?.();
            if (clob) {
              const openOrders = await clob.getOpenOrders();
              if (openOrders?.length) {
                const ids = openOrders.map(o => o.id).filter(Boolean);
                if (ids.length) {
                  await clob.cancelOrders(ids).catch(() => {});
                  console.log(`[maker:${campaignId.slice(0,8)}] Cancelled ${ids.length} Poly orders`);
                }
              }
            }
          } catch {}
          return; // skip trading this tick
        }
        // Reset flag when slot changes
        if (secsToNext > 5) state.preCancelDone = false;
      }

      // ── Recurring: check if slot rolled over ──
      if (recurring && recurringType && !state.renewLock) {
        const urls = getCurrentSlotUrls(recurringType);
        if (urls && urls.slot !== state.currentSlot) {
          state.renewLock = true;
          // Cancel pending KS order before renewing
          if (state.pendingOrderId) {
            try { await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${state.pendingOrderId}`, { method: 'DELETE' }); } catch {}
            state.pendingOrderId = null;
          }
          console.log(`[maker:${campaignId.slice(0,8)}] Cancelled pending order for slot rollover`);
          console.log(`[auto-campaign:${campaignId.slice(0,8)}] Slot rolled over → renewing session`);

          // Stop old session
          const oldSess = sessions.get(state.currentSessionId);
          if (oldSess) {
            clearInterval(oldSess.interval);
            if (oldSess.bookInterval) clearInterval(oldSess.bookInterval);
            oldSess.kalshiWs?.close();
            oldSess.polyWs?.close();
            sessions.delete(state.currentSessionId);
          }

          // Start new session for current slot
          const newSlot = await startSlotSession(recurringType);
          if (newSlot) {
            state.currentSessionId = newSlot.sessionId;
            state.currentSlot = newSlot.slot;
            // Update campaign in DB
            await pool.query(
              `UPDATE arb_campaigns SET session_id = $1, kalshi_url = $2, poly_url = $3 WHERE id = $4`,
              [newSlot.sessionId, newSlot.kalshiUrl, newSlot.polyUrl, campaignId],
            ).catch(() => {});
            // Reset cooldown and strategy lock for new slot
            state.cooldownUntil = Date.now() + 5000; // 5s grace for new session to warm up
            state.slotStrategy = null; // allow re-picking strategy for new slot
          } else {
            // Retry in 10s
            state.currentSlot = 0;
          }
          state.renewLock = false;
          return;
        }
        if (state.currentSlot === 0) state.currentSlot = urls?.slot || 0;
      }

      // ── Early exit check — sell 5 shares/sec if combined bids > $1 + threshold ──
      if (!state.exitCooldownUntil) state.exitCooldownUntil = 0;
      if (earlyExit && !state.lock && Date.now() >= state.exitCooldownUntil) {
        const sess0 = sessions.get(state.currentSessionId);
        if (sess0?.bookCache?.data) {
          const book = sess0.bookCache.data;
          // Check sell prices (bids) — what we'd get selling our positions
          const ksYesBid = book.kalshi?.yesBid;
          const ksNoBid = book.kalshi?.noBid;
          const polyUpBid = book.poly?.up?.bestBid;
          const polyDownBid = book.poly?.down?.bestBid;
          const exitThresh = exitThresholdCents / 100;

          // Strategy A positions: own KS YES + Poly Down → sell at bids
          const sellA = ksYesBid != null && polyDownBid != null ? ksYesBid + polyDownBid : null;
          const exitProfitA = sellA != null ? sellA - 1 : null; // profit vs $1 settlement

          // Strategy B positions: own KS NO + Poly Up → sell at bids
          const sellB = ksNoBid != null && polyUpBid != null ? ksNoBid + polyUpBid : null;
          const exitProfitB = sellB != null ? sellB - 1 : null;

          // Check depth
          const ksYesBidQty = book.kalshi?.yesBidQty || 0;
          const ksNoBidQty = book.kalshi?.noBidQty || 0;
          const polyUpBidQty = book.poly?.up?.bestBidQty || 0;
          const polyDownBidQty = book.poly?.down?.bestBidQty || 0;

          if (exitProfitA != null && exitProfitA >= exitThresh && ksYesBidQty >= 5 && polyDownBidQty >= 5) {
            state.lock = true;
            console.log(`[early-exit:${campaignId.slice(0,8)}] SELL A: KS YES bid ${(ksYesBid*100).toFixed(0)}¢ + Poly DOWN bid ${(polyDownBid*100).toFixed(0)}¢ = ${(sellA*100).toFixed(0)}¢ → +${(exitProfitA*100).toFixed(0)}¢ extra`);
            try {
              // Execute sell on both platforms
              const r = await fetch(`http://localhost:${process.env.PORT || 3001}/api/arb/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: state.currentSessionId, strategy: 'A', swapPoly, marketOrder: true, sell: true }),
              });
              const d = await r.json();
              if (d.success) {
                await pool.query('UPDATE arb_campaigns SET total_trades = total_trades + 1, total_profit = total_profit + $1 WHERE id = $2', [exitProfitA * 5, campaignId]).catch(() => {});
              }
            } catch (e) { console.error(`[early-exit] Error:`, e.message?.slice(0, 100)); }
            state.exitCooldownUntil = Date.now() + 1000; // 1 sec between sells
            state.lock = false;
          } else if (exitProfitB != null && exitProfitB >= exitThresh && ksNoBidQty >= 5 && polyUpBidQty >= 5) {
            state.lock = true;
            console.log(`[early-exit:${campaignId.slice(0,8)}] SELL B: KS NO bid ${(ksNoBid*100).toFixed(0)}¢ + Poly UP bid ${(polyUpBid*100).toFixed(0)}¢ = ${(sellB*100).toFixed(0)}¢ → +${(exitProfitB*100).toFixed(0)}¢ extra`);
            try {
              const r = await fetch(`http://localhost:${process.env.PORT || 3001}/api/arb/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: state.currentSessionId, strategy: 'B', swapPoly, marketOrder: true, sell: true }),
              });
              const d = await r.json();
              if (d.success) {
                await pool.query('UPDATE arb_campaigns SET total_trades = total_trades + 1, total_profit = total_profit + $1 WHERE id = $2', [exitProfitB * 5, campaignId]).catch(() => {});
              }
            } catch (e) { console.error(`[early-exit] Error:`, e.message?.slice(0, 100)); }
            state.exitCooldownUntil = Date.now() + 1000; // 1 sec between sells
            state.lock = false;
          }

          // Debug log every 30s
          if (!state.lastExitDebug || Date.now() - state.lastExitDebug > 30000) {
            state.lastExitDebug = Date.now();
            if (sellA != null || sellB != null) {
              console.log(`[early-exit:${campaignId.slice(0,8)}] Bids: A=${sellA != null ? (sellA*100).toFixed(0)+'¢' : '—'} B=${sellB != null ? (sellB*100).toFixed(0)+'¢' : '—'} | need ${(100 + exitThresholdCents)}¢+`);
            }
          }
        }
      }

      // ── MAKER STRATEGY ──
      if (state.lock) return;
      state.lock = true; // Acquire lock IMMEDIATELY to prevent parallel ticks
      const sess = sessions.get(state.currentSessionId);
      if (!sess?.bookCache?.data) { state.lock = false; return; }

      const book = sess.bookCache.data;
      const fee = 0.02;
      const halfTarget = thresholdCents / 2 / 100; // e.g. 4¢ target → 2¢ half
      const polyUpAsk = book.poly?.up?.bestAsk;
      const polyDownAsk = book.poly?.down?.bestAsk;
      const ksYesBid = book.kalshi?.yesBid;
      const ksNoBid = book.kalshi?.noBid;
      const ksYesAsk = book.kalshi?.yesAsk;
      const ksNoAsk = book.kalshi?.noAsk;
      const pDownAsk = swapPoly ? polyUpAsk : polyDownAsk;
      const pUpAsk = swapPoly ? polyDownAsk : polyUpAsk;

      // Wrap everything in try/finally to ALWAYS release lock
      try {

      // ── STATE 1: We have a pending Kalshi limit order — check it ──
      if (state.pendingOrderId) {
        try {
          const or = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${state.pendingOrderId}`);
          if (!or.ok) { state.pendingOrderId = null; return; }
          const od = await or.json();
          const order = od.order;
          const filled = parseFloat(order?.fill_count_fp || '0');
          const status = order?.status;

          // FILLED → FOK Poly immediately
          if (filled >= 5 || status === 'executed') {
            const filledShares = Math.round(filled); // exact KS fill count
            // CRITICAL: clear pending FIRST to prevent duplicate Poly fires
            const savedStrategy = state.pendingStrategy;
            const savedKsSide = state.pendingKsSide;
            const savedKsPrice = state.pendingKsPrice;
            const savedPolyTokenId = state.pendingPolyTokenId;
            const savedPolyPrice = state.pendingPolyPrice;
            const savedOrderId = state.pendingOrderId;
            state.pendingOrderId = null;
            state.pendingStrategy = null;

            // RECORD KS FILL IN DB IMMEDIATELY — before Poly attempt
            const polySideEarly2 = savedStrategy === 'A' ? 'down' : 'up';
            await pool.query(
              `INSERT INTO arb_trades (session_id, strategy, kalshi_ticker, kalshi_side, kalshi_limit_cents, kalshi_filled, kalshi_fill_price, kalshi_shares, kalshi_order_id, poly_side, poly_limit_price, poly_filled, both_filled, total_cost, expected_payout, expected_profit)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
              [state.currentSessionId, savedStrategy, sess.kalshiTicker, savedKsSide, savedKsPrice,
               true, savedKsPrice / 100, filledShares, savedOrderId,
               polySideEarly2, savedPolyPrice, false, false, 0, 0, 0],
            ).catch(e => console.error('[maker] DB early insert error:', e.message));

            // 2 or less → skip Poly hedge. 3+ → hedge 5 on Poly
            if (filledShares <= 2) {
              console.log(`[maker:${campaignId.slice(0,8)}] KS FILLED ${filledShares}sh @ ${savedKsPrice}¢ — too few to hedge, skipping Poly`);
              state.lock = false;
              return;
            }
            const polyHedgeShares = 5;
            console.log(`[maker:${campaignId.slice(0,8)}] KS FILLED ${filledShares}sh @ ${savedKsPrice}¢ → FAK Poly ${polyHedgeShares}sh @ ${(savedPolyPrice*100).toFixed(0)}¢`);

            // FAK Poly
            const clob = getClobClient?.();
            if (clob) {
              try {
                const { polyTokens, negRisk, tickSize } = sess;
                const signed = await clob.createOrder({
                  tokenID: savedPolyTokenId,
                  price: Math.min(0.99, savedPolyPrice + 0.02),
                  size: polyHedgeShares,
                  side: 'BUY',
                }, { tickSize: tickSize || '0.01', negRisk: negRisk || false });
                const result = await clob.postOrder(signed, 'GTC'); // GTC — cancel unfilled after = FAK
                // Cancel unfilled remainder immediately (FAK behavior)
                const polyOid = result?.orderID;
                if (polyOid && result?.status !== 'matched') {
                  await new Promise(r => setTimeout(r, 500)); // brief wait for fills
                  try { await clob.cancelOrders([polyOid]); } catch {}
                }
                const polyFilled = result?.status === 'matched' || (result?.takingAmount && parseFloat(result.takingAmount) > 0);
                console.log(`[maker:${campaignId.slice(0,8)}] Poly FAK: ${result?.status} taking=${result?.takingAmount || '?'}`);

                // Track consecutive Poly failures — stop after 3
                if (!polyFilled) {
                  state.polyFailCount = (state.polyFailCount || 0) + 1;
                  console.log(`[maker:${campaignId.slice(0,8)}] Poly fail #${state.polyFailCount}`);
                  if (state.polyFailCount >= 3) {
                    console.log(`[maker:${campaignId.slice(0,8)}] 3 consecutive Poly failures — STOPPING campaign`);
                    await pool.query('UPDATE arb_campaigns SET auto_enabled = false, status = $1, stopped_at = NOW() WHERE id = $2', ['stopped', campaignId]).catch(() => {});
                    stopped = true;
                    return;
                  }
                } else {
                  state.polyFailCount = 0;
                }

                const polySide = savedStrategy === 'A' ? 'down' : 'up';
                const polyActualCost = result?.makingAmount && result?.takingAmount ? parseFloat(result.makingAmount) / parseFloat(result.takingAmount) : savedPolyPrice;
                await pool.query(
                  `INSERT INTO arb_trades (session_id, strategy, kalshi_ticker, kalshi_side, kalshi_limit_cents, kalshi_filled, kalshi_fill_price, kalshi_shares, kalshi_order_id, poly_token_id, poly_side, poly_limit_price, poly_filled, poly_fill_price, poly_shares, poly_order_id, both_filled, total_cost, expected_payout, expected_profit)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
                  [state.currentSessionId, savedStrategy, sess.kalshiTicker, savedKsSide, savedKsPrice,
                   true, savedKsPrice / 100, 5, savedOrderId,
                   savedPolyTokenId, polySide, savedPolyPrice,
                   polyFilled, polyActualCost, 5, result?.orderID || null,
                   polyFilled, (savedKsPrice / 100 + polyActualCost) * 5, 5, 0],
                ).catch(e => console.error('[maker] DB error:', e.message));

                await pool.query('UPDATE arb_campaigns SET total_trades = total_trades + 1, last_trade_at = NOW() WHERE id = $1', [campaignId]).catch(() => {});
              } catch (e) {
                console.error(`[maker:${campaignId.slice(0,8)}] Poly FOK error:`, e.message?.slice(0, 100));
              }
            }
            state.lock = false;
            return;
          }

          // CANCELLED/EXPIRED → clear
          if (status === 'canceled' || status === 'expired') {
            state.pendingOrderId = null;
            return;
          }

          // STILL RESTING → check if spread is still good enough to keep the order
          const currentPolyAsk = state.pendingStrategy === 'A' ? pDownAsk : pUpAsk;
          if (currentPolyAsk != null) {
            const combinedCost = state.pendingKsPrice / 100 + currentPolyAsk;
            if (combinedCost > 0.98) {
              // Poly ask moved up too much — our KS fill + Poly FOK would be unprofitable
              try { await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${state.pendingOrderId}`, { method: 'DELETE' }); } catch {}
              console.log(`[maker:${campaignId.slice(0,8)}] Cancelled — combined ${(combinedCost*100).toFixed(0)}¢ > 98¢`);
              state.pendingOrderId = null;
            }
          }
          return;
        } catch (e) {
          console.error(`[maker:${campaignId.slice(0,8)}] Check order error:`, e.message?.slice(0, 80));
          return;
        }
      }

      // ── STATE 2: No pending order — check if we should place one ──

      // DB COOLDOWN: check last fill time
      try {
        const lastTrade = await pool.query(
          `SELECT ts FROM arb_trades WHERE session_id = $1 ORDER BY ts DESC LIMIT 1`,
          [state.currentSessionId],
        );
        if (lastTrade.rows[0]) {
          const secsSinceLast = (Date.now() - new Date(lastTrade.rows[0].ts).getTime()) / 1000;
          if (secsSinceLast < cooldownSec) return;
        }
      } catch {}

      // MAX POSITION CHECK: query Kalshi ORDERS for this ticker + DB for Poly
      try {
        let ksShares = 0;
        // Count filled shares from Kalshi executed orders for THIS specific market
        if (sess.kalshiTicker) {
          const ordR = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders?ticker=${encodeURIComponent(sess.kalshiTicker)}&status=executed&limit=50`);
          if (ordR.ok) {
            const ordD = await ordR.json();
            for (const o of (ordD.orders || [])) {
              ksShares += Math.round(parseFloat(o.fill_count_fp || '0'));
            }
          }
        }
        // Also count resting orders (not yet filled but on the book)
        if (sess.kalshiTicker) {
          const restR = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders?ticker=${encodeURIComponent(sess.kalshiTicker)}&status=resting&limit=50`);
          if (restR.ok) {
            const restD = await restR.json();
            for (const o of (restD.orders || [])) {
              ksShares += Math.round(parseFloat(o.initial_count_fp || '0'));
            }
          }
        }
        // Check DB for Poly fills (all sessions for this ticker)
        const polyCheck = await pool.query(
          `SELECT COALESCE(SUM(CASE WHEN poly_filled THEN poly_shares ELSE 0 END), 0) as poly_shares
           FROM arb_trades WHERE kalshi_ticker = $1`,
          [sess.kalshiTicker],
        );
        const polyShares = parseInt(polyCheck.rows[0]?.poly_shares || '0');

        if (!state.lastCapLog2 || Date.now() - state.lastCapLog2 > 30000) {
          state.lastCapLog2 = Date.now();
          console.log(`[maker:${campaignId.slice(0,8)}] Positions: KS ${ksShares}/30 Poly ${polyShares}/30 (${sess.kalshiTicker})`);
        }

        if (ksShares >= 30 || polyShares >= 30) {
          // CAP HIT — cancel ALL open orders and disable campaign
          if (state.pendingOrderId) {
            try { await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${state.pendingOrderId}`, { method: 'DELETE' }); } catch {}
            state.pendingOrderId = null;
          }
          // Cancel ALL resting KS orders for this ticker
          try {
            const openOrders = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders?status=resting&limit=50`);
            const oo = await openOrders.json();
            for (const o of (oo.orders || [])) {
              if (o.ticker === sess.kalshiTicker) {
                await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${o.order_id}`, { method: 'DELETE' }).catch(() => {});
              }
            }
          } catch {}
          // Just pause — don't disable. Will resume on next slot rollover
          console.log(`[maker:${campaignId.slice(0,8)}] CAP HIT: KS ${ksShares}/30 Poly ${polyShares}/30 — pausing until next slot`);
          return;
        }
      } catch {}

      // STOP-LOSS: if platforms diverge by 20¢+ (one says up, other says down), sell everything
      // If both agree on direction → hedge works → keep
      {
        const ksYesPrice = ksYesBid != null && ksYesAsk != null ? (ksYesBid + ksYesAsk) / 2 : ksYesBid || ksYesAsk;
        const polyUpPrice = polyUpAsk != null ? polyUpAsk : null;
        if (ksYesPrice == null || polyUpPrice == null) {
          // Can't check divergence — don't trade without safety check
          return;
        }
        {
          const divergence = Math.abs(ksYesPrice - polyUpPrice);
          // Log divergence every 30s
          if (!state.lastDivLog || Date.now() - state.lastDivLog > 30000) {
            state.lastDivLog = Date.now();
            if (divergence > 0.10) {
              console.log(`[diverge:${campaignId.slice(0,8)}] KS YES ${(ksYesPrice*100).toFixed(0)}¢ vs Poly UP ${(polyUpPrice*100).toFixed(0)}¢ = ${(divergence*100).toFixed(0)}¢ gap`);
            }
          }

          // Gap recovered below 10¢ — reset hedge flag
          if (divergence < 0.10 && state.hedgedDivergence) {
            state.hedgedDivergence = false;
            console.log(`[maker:${campaignId.slice(0,8)}] Gap recovered to ${(divergence*100).toFixed(0)}¢ — resuming`);
          }

          // 10¢+ gap → stop buying (don't sell, just pause)
          if (divergence >= 0.10 && divergence < 0.20) {
            if (!state.lastGapLog || Date.now() - state.lastGapLog > 30000) {
              state.lastGapLog = Date.now();
              console.log(`[maker:${campaignId.slice(0,8)}] GAP ${(divergence*100).toFixed(0)}¢ ≥ 10¢ — pausing buys`);
            }
            return;
          }

          if (divergence >= 0.20) {
            // Wait 10s after session starts before allowing stop-loss (prices need to settle)
            if (!state.sessionStartTime) state.sessionStartTime = Date.now();
            if (Date.now() - state.sessionStartTime < 10000) {
              if (!state.lastDivLog || Date.now() - state.lastDivLog > 5000) {
                state.lastDivLog = Date.now();
                console.log(`[stop-loss:${campaignId.slice(0,8)}] DIVERGENCE ${(divergence*100).toFixed(0)}¢ — waiting 10s grace period`);
              }
              // skip stop-loss during grace period
            } else if (!state.hedgedDivergence) {
            // Platforms disagree by 20¢+ — HEDGE opposite on the platform that's over 50¢
            // Don't sell — lock in position by buying opposite on same platform
            const posR = await pool.query(
              `SELECT kalshi_side, SUM(kalshi_shares) as shares FROM arb_trades WHERE session_id = $1 AND kalshi_filled = true GROUP BY kalshi_side`,
              [state.currentSessionId],
            );

            for (const pos of posR.rows) {
              const shares = parseInt(pos.shares);
              if (shares <= 0) continue;

              // Check which side is over 50¢
              const ksPrice = pos.kalshi_side === 'yes' ? ksYesPrice : (1 - ksYesPrice);
              if (ksPrice > 0.50) {
                // KS side is over 50¢ — buy opposite on KS
                const oppSide = pos.kalshi_side === 'yes' ? 'no' : 'yes';
                const oppPrice = (1 - ksPrice);
                const limitCents = Math.round(oppPrice * 100) + 1; // slightly above to fill
                const limitDollars = (limitCents / 100).toFixed(2);
                console.log(`[hedge-lock:${campaignId.slice(0,8)}] KS ${pos.kalshi_side} at ${(ksPrice*100).toFixed(0)}¢ > 50¢ → buying KS ${oppSide.toUpperCase()} ${shares}sh @ ${limitCents}¢`);

                const body = { ticker: sess.kalshiTicker, action: 'buy', side: oppSide, type: 'limit', count: shares };
                if (oppSide === 'yes') body.yes_price_dollars = limitDollars;
                else body.no_price_dollars = limitDollars;
                try {
                  const hr = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders`, { method: 'POST', body: JSON.stringify(body) });
                  const hd = await hr.json();
                  console.log(`[hedge-lock:${campaignId.slice(0,8)}] KS hedge: ${hd.order?.fill_count_fp}/${shares} status: ${hd.order?.status}`);
                } catch (e) { console.error(`[hedge-lock] error:`, e.message?.slice(0, 80)); }
              }
            }

            state.hedgedDivergence = true;
            // Cancel pending orders
            if (state.pendingOrderId) {
              try { await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${state.pendingOrderId}`, { method: 'DELETE' }); } catch {}
              state.pendingOrderId = null;
            }
            console.log(`[hedge-lock:${campaignId.slice(0,8)}] Positions locked. Waiting for gap < 10¢ to resume.`);
            return;
          } else {
            // Already hedged divergence — just wait
            return;
          }
          } // close else (grace period)
        }
      }

      // Check spreads — at ask prices to see if there's any opportunity
      const costA = ksYesAsk != null && pDownAsk != null ? ksYesAsk + pDownAsk : null;
      const profitA = costA != null ? 1 - fee - costA : null;
      const costB = ksNoAsk != null && pUpAsk != null ? ksNoAsk + pUpAsk : null;
      const profitB = costB != null ? 1 - fee - costB : null;

      // Debug log
      if (!state.lastDebug || Date.now() - state.lastDebug > 30000) {
        state.lastDebug = Date.now();
        const ksBidQtyDbg = book.kalshi?.yesBidQty;
        const polyBidQtyDbg = book.poly?.down?.bestBidQty;
        console.log(`[maker:${campaignId.slice(0,8)}] Book: A=${profitA != null ? (profitA*100).toFixed(1)+'¢' : '—'} B=${profitB != null ? (profitB*100).toFixed(1)+'¢' : '—'} | threshold=${thresholdCents}¢ | ksBid=${ksYesBid != null ? (ksYesBid*100).toFixed(0)+'¢' : 'null'}(${ksBidQtyDbg}) pDownBid=${pDownBid != null ? (pDownBid*100).toFixed(0)+'¢' : 'null'}(${polyBidQtyDbg}) | no pending`);
      }

      // Need profit >= half target to place maker order (we'll gain the other half from maker rebate)
      const threshold = thresholdCents / 100;
      let bestStrategy = null;

      // LOCK to one strategy per slot — once we trade A, stay A for the entire slot
      if (state.slotStrategy) {
        // Already committed to a strategy this slot
        const locked = state.slotStrategy;
        const profit = locked === 'A' ? profitA : profitB;
        const cost = locked === 'A' ? costA : costB;
        if (profit != null && profit >= halfTarget && cost <= 0.96) bestStrategy = locked;
      } else {
        // First trade of slot — pick best
        if (profitA != null && profitA >= halfTarget && costA <= 0.96 && (profitB == null || profitA >= profitB)) bestStrategy = 'A';
        else if (profitB != null && profitB >= halfTarget && costB <= 0.96) bestStrategy = 'B';
        if (bestStrategy) {
          state.slotStrategy = bestStrategy;
          console.log(`[maker:${campaignId.slice(0,8)}] Locked to strategy ${bestStrategy} for this slot`);
        }
      }

      if (!bestStrategy) return;

      // Determine Kalshi side and price
      const { polyTokens } = sess;
      const polyDownIdx = swapPoly ? 0 : 1;
      const polyUpIdx = swapPoly ? 1 : 0;
      let ksSide, ksLimitPrice, polyTokenId, polyAsk;

      // KS limit price = price that gives (threshold - 1)¢ profit
      // profit = $1 - fee - ksPrice - polyAsk → ksPrice = (1 - fee - polyAsk) - (threshold-1)/100
      // Cap at ask - 1¢ to always be MAKER (never cross the book)
      if (bestStrategy === 'A') {
        ksSide = 'yes';
        polyTokenId = polyTokens?.[polyDownIdx];
        polyAsk = pDownAsk;
        const targetPrice = Math.round((0.98 - polyAsk) * 100 - thresholdCents + 1);
        const askCents = ksYesAsk != null ? Math.round(ksYesAsk * 100) : 99;
        ksLimitPrice = Math.max(1, Math.min(targetPrice, askCents - 1));
      } else {
        ksSide = 'no';
        polyTokenId = polyTokens?.[polyUpIdx];
        polyAsk = pUpAsk;
        const targetPrice = Math.round((0.98 - polyAsk) * 100 - thresholdCents + 1);
        const askCents = ksNoAsk != null ? Math.round(ksNoAsk * 100) : 99;
        ksLimitPrice = Math.max(1, Math.min(targetPrice, askCents - 1));
      }

      // Verify combined cost < 96¢ (KS maker at bid+1 + Poly taker at ask)
      const makerCost = ksLimitPrice / 100 + polyAsk;
      if (makerCost > 0.96) return;

      const minPolyShares = 5;

      // Check book depth — for dual passive limits we check BID depth (our orders sit near bid)
      // Only need 5+ shares at bid since we're placing small 5-share orders
      const ksBidQty = ksSide === 'yes' ? book.kalshi?.yesBidQty : book.kalshi?.noBidQty;
      const polyBidQty = bestStrategy === 'A'
        ? (swapPoly ? book.poly?.up?.bestBidQty : book.poly?.down?.bestBidQty)
        : (swapPoly ? book.poly?.down?.bestBidQty : book.poly?.up?.bestBidQty);
      if (ksBidQty != null && ksBidQty < 5) return;
      if (polyBidQty != null && polyBidQty < 5) return;

      // Determine mode: KS ask in 40-60¢ range → maker limit, outside → FAK taker
      const ksAskCents = ksSide === 'yes'
        ? (ksYesAsk != null ? Math.round(ksYesAsk * 100) : null)
        : (ksNoAsk != null ? Math.round(ksNoAsk * 100) : null);
      const isMakerRange = ksAskCents != null && ksAskCents >= 40 && ksAskCents <= 60;

      state.lock = true;
      try {
        if (isMakerRange) {
          // ── MAKER MODE: place limit at target price, wait for fill ──
          console.log(`[maker:${campaignId.slice(0,8)}] MAKER KS ${ksSide.toUpperCase()} limit ${minPolyShares}sh @ ${ksLimitPrice}¢ | Poly ask: ${(polyAsk*100).toFixed(0)}¢ | combined: ${(ksLimitPrice + Math.round(polyAsk*100))}¢`);

          const priceDollars = (ksLimitPrice / 100).toFixed(2);
          const body = {
            ticker: sess.kalshiTicker,
            action: 'buy',
            side: ksSide,
            type: 'limit',
            count: minPolyShares,
          };
          if (ksSide === 'yes') body.yes_price_dollars = priceDollars;
          else body.no_price_dollars = priceDollars;

          const res = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders`, {
            method: 'POST',
            body: JSON.stringify(body),
          });
          const data = await res.json();

          if (res.ok && data.order?.order_id) {
            state.pendingOrderId = data.order.order_id;
            state.pendingStrategy = bestStrategy;
            state.pendingKsSide = ksSide;
            state.pendingKsPrice = ksLimitPrice;
            state.pendingPolyTokenId = polyTokenId;
            state.pendingPolyPrice = polyAsk;
            console.log(`[maker:${campaignId.slice(0,8)}] Order placed: ${data.order.order_id.slice(0,12)} ${ksSide} @ ${ksLimitPrice}¢`);

            if (parseFloat(data.order.fill_count_fp || '0') >= 5) {
              console.log(`[maker:${campaignId.slice(0,8)}] Immediate fill!`);
            }
          } else {
            console.error(`[maker:${campaignId.slice(0,8)}] Order failed:`, data.error?.message || res.status);
          }
        } else {
          // ── TAKER MODE: FAK both immediately ──
          const ksPrice = ksAskCents || ksLimitPrice;
          console.log(`[maker:${campaignId.slice(0,8)}] TAKER KS ${ksSide.toUpperCase()} FAK ${minPolyShares}sh @ ${ksPrice}¢ + Poly @ ${(polyAsk*100).toFixed(0)}¢ = ${(ksPrice + Math.round(polyAsk*100))}¢`);

          // FAK Kalshi at ask
          const priceDollars = (ksPrice / 100).toFixed(2);
          const body = {
            ticker: sess.kalshiTicker,
            action: 'buy',
            side: ksSide,
            type: 'limit',
            count: minPolyShares,
          };
          if (ksSide === 'yes') body.yes_price_dollars = priceDollars;
          else body.no_price_dollars = priceDollars;

          const ksRes = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders`, {
            method: 'POST',
            body: JSON.stringify(body),
          });
          const ksData = await ksRes.json();
          const ksFilled = parseFloat(ksData.order?.fill_count_fp || '0');
          const ksOrderId = ksData.order?.order_id;

          // Cancel resting remainder if partial fill
          if (ksOrderId && ksFilled < 5) {
            try { await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${ksOrderId}`, { method: 'DELETE' }); } catch {}
          }

          if ((ksRes.ok || ksRes.status === 201) && ksFilled > 0) {
            const filledShares = Math.round(ksFilled);

            // RECORD KS FILL IN DB IMMEDIATELY — before Poly attempt
            // This ensures the 50-share cap sees it even if Poly fails
            const polySideEarly = bestStrategy === 'A' ? 'down' : 'up';
            await pool.query(
              `INSERT INTO arb_trades (session_id, strategy, kalshi_ticker, kalshi_side, kalshi_limit_cents, kalshi_filled, kalshi_fill_price, kalshi_shares, kalshi_order_id, poly_side, poly_limit_price, poly_filled, both_filled, total_cost, expected_payout, expected_profit)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
              [state.currentSessionId, bestStrategy, sess.kalshiTicker, ksSide, ksPrice,
               true, ksPrice / 100, filledShares, ksOrderId,
               polySideEarly, polyAsk, false, false, 0, 0, 0],
            ).catch(e => console.error('[maker] DB early insert error:', e.message));

            // 2 or less → skip Poly. 3+ → hedge 5
            if (filledShares <= 2) {
              console.log(`[maker:${campaignId.slice(0,8)}] KS FAK filled ${filledShares}sh — too few, skipping Poly`);
            } else {
            const polyHedgeShares2 = 5;
            console.log(`[maker:${campaignId.slice(0,8)}] KS FAK filled ${filledShares}sh → FAK Poly ${polyHedgeShares2}sh`);

            // FAK Poly immediately
            const clob = getClobClient?.();
            if (clob) {
              try {
                const { polyTokens, negRisk, tickSize } = sess;
                const signed = await clob.createOrder({
                  tokenID: polyTokenId,
                  price: Math.min(0.99, polyAsk + 0.02),
                  size: polyHedgeShares2,
                  side: 'BUY',
                }, { tickSize: tickSize || '0.01', negRisk: negRisk || false });
                const result = await clob.postOrder(signed, 'GTC'); // GTC + cancel = FAK
                const polyOid2 = result?.orderID;
                if (polyOid2 && result?.status !== 'matched') {
                  await new Promise(r => setTimeout(r, 500));
                  try { await clob.cancelOrders([polyOid2]); } catch {}
                }
                const polyFilled = result?.status === 'matched' || (result?.takingAmount && parseFloat(result.takingAmount) > 0);
                console.log(`[maker:${campaignId.slice(0,8)}] Poly FAK: ${result?.status} taking=${result?.takingAmount || '?'}`);

                if (!polyFilled) {
                  state.polyFailCount = (state.polyFailCount || 0) + 1;
                  console.log(`[maker:${campaignId.slice(0,8)}] Poly fail #${state.polyFailCount}`);
                  if (state.polyFailCount >= 3) {
                    console.log(`[maker:${campaignId.slice(0,8)}] 3 consecutive Poly failures — STOPPING campaign`);
                    await pool.query('UPDATE arb_campaigns SET auto_enabled = false, status = $1, stopped_at = NOW() WHERE id = $2', ['stopped', campaignId]).catch(() => {});
                    stopped = true;
                    return;
                  }
                } else {
                  state.polyFailCount = 0;
                }

                const polySide = bestStrategy === 'A' ? 'down' : 'up';
                const polyActualCost = result?.makingAmount && result?.takingAmount ? parseFloat(result.makingAmount) / parseFloat(result.takingAmount) : polyAsk;
                await pool.query(
                  `INSERT INTO arb_trades (session_id, strategy, kalshi_ticker, kalshi_side, kalshi_limit_cents, kalshi_filled, kalshi_fill_price, kalshi_shares, kalshi_order_id, poly_token_id, poly_side, poly_limit_price, poly_filled, poly_fill_price, poly_shares, poly_order_id, both_filled, total_cost, expected_payout, expected_profit)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
                  [state.currentSessionId, bestStrategy, sess.kalshiTicker, ksSide, ksPrice,
                   true, ksPrice / 100, filledShares, ksData.order?.order_id,
                   polyTokenId, polySide, polyAsk,
                   polyFilled, polyActualCost, filledShares, result?.orderID || null,
                   polyFilled, (ksPrice / 100 + polyActualCost) * filledShares, filledShares, 0],
                ).catch(e => console.error('[maker] DB error:', e.message));

                await pool.query('UPDATE arb_campaigns SET total_trades = total_trades + 1, last_trade_at = NOW() WHERE id = $1', [campaignId]).catch(() => {});
              } catch (e) {
                console.error(`[maker:${campaignId.slice(0,8)}] Poly FAK error:`, e.message?.slice(0, 100));
              }
            }
          } // close filledShares > 2 else
          } else if (!ksRes.ok && ksRes.status !== 201) {
            console.error(`[maker:${campaignId.slice(0,8)}] KS FAK failed:`, ksData.error?.message || ksRes.status);
          } else {
            // 0 fills — cancel the resting order so it doesn't accumulate
            if (ksOrderId) {
              try { await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${ksOrderId}`, { method: 'DELETE' }); } catch {}
            }
            console.log(`[maker:${campaignId.slice(0,8)}] KS FAK: 0 fills (no match at ${ksPrice}¢) — cancelled`);
          }
        }
      } catch (e) {
        console.error(`[maker:${campaignId.slice(0,8)}] Place error:`, e.message?.slice(0, 100));
      }

      } finally { state.lock = false; }

      } finally {
        // Schedule next tick — only AFTER this one fully completes
        if (!stopped) setTimeout(tick, 500);
      }
    }
    setTimeout(tick, 500); // start the chain

    // Store stop function instead of interval
    const stopFn = () => { stopped = true; };
    campaigns.set(campaignId, { stop: stopFn, state, sessionId: state.currentSessionId });
    const tag = recurring ? ` [RECURRING ${recurringType}]` : '';
    console.log(`[auto-campaign:${campaignId.slice(0,8)}] Started (threshold: ${thresholdCents}¢, cooldown: ${cooldownSec}s)${tag}`);
  }

  /** List all campaigns */
  app.get('/api/arb/campaigns', async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM arb_campaigns ORDER BY created_at DESC LIMIT 50');
      // Enrich running campaigns with live book spread
      const enriched = r.rows.map(c => {
        if (c.status !== 'running') return c;
        const camp = campaigns.get(c.id);
        const sid = camp?.state?.currentSessionId || c.session_id;
        const sess = sid ? sessions.get(sid) : null;
        const book = sess?.bookCache?.data;
        if (!book) return c;

        const ksYA = book.kalshi?.yesAsk;
        const ksNA = book.kalshi?.noAsk;
        const pUA = book.poly?.up?.bestAsk;
        const pDA = book.poly?.down?.bestAsk;
        const fee = 0.02;
        const swap = c.swap_poly;

        const pDown = swap ? pUA : pDA;
        const pUp = swap ? pDA : pUA;
        const costA = ksYA != null && pDown != null ? ksYA + pDown : null;
        const costB = ksNA != null && pUp != null ? ksNA + pUp : null;
        const profitA = costA != null ? 1 - fee - costA : null;
        const profitB = costB != null ? 1 - fee - costB : null;
        const best = profitA != null && profitB != null ? Math.max(profitA, profitB) : (profitA ?? profitB);

        return {
          ...c,
          live: {
            ksYes: ksYA, ksNo: ksNA, polyUp: pUA, polyDown: pDA,
            profitA: profitA != null ? Math.round(profitA * 100) : null,
            profitB: profitB != null ? Math.round(profitB * 100) : null,
            best: best != null ? Math.round(best * 100) : null,
            expiration: book.kalshi?.expiration || null,
          },
        };
      });
      res.json({ campaigns: enriched });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Update campaign (toggle auto, change threshold, etc) */
  app.patch('/api/arb/campaigns/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { autoEnabled, autoThreshold, autoCooldown, swapPoly, earlyExit, exitThreshold } = req.body;

      const r = await pool.query('SELECT * FROM arb_campaigns WHERE id = $1', [id]);
      const campaign = r.rows[0];
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

      // Update DB — also set status when enabling/disabling
      const newStatus = autoEnabled === true ? 'running' : autoEnabled === false ? 'stopped' : null;
      await pool.query(
        `UPDATE arb_campaigns SET auto_enabled = COALESCE($1, auto_enabled), auto_threshold_cents = COALESCE($2, auto_threshold_cents), auto_cooldown_sec = COALESCE($3, auto_cooldown_sec), swap_poly = COALESCE($4, swap_poly), early_exit = COALESCE($5, early_exit), exit_threshold_cents = COALESCE($6, exit_threshold_cents)${newStatus ? ', status = \'' + newStatus + '\'' : ''}${autoEnabled === false ? ', stopped_at = NOW()' : ''} WHERE id = $7`,
        [autoEnabled, autoThreshold, autoCooldown, swapPoly, earlyExit, exitThreshold, id],
      );

      // Start/stop auto
      const existing = campaigns.get(id);
      if (autoEnabled && !existing && campaign.session_id) {
        startCampaignAuto(id, campaign.session_id, autoThreshold || campaign.auto_threshold_cents, autoCooldown || campaign.auto_cooldown_sec, swapPoly ?? campaign.swap_poly, campaign.recurring || false, null, campaign.early_exit || false, campaign.exit_threshold_cents || 4);
      } else if (autoEnabled === false && existing) {
        if (existing.stop) existing.stop(); else if (existing.interval) clearInterval(existing.interval);
        campaigns.delete(id);
        console.log(`[auto-campaign:${id.slice(0,8)}] Stopped`);
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Stop a campaign */
  app.post('/api/arb/campaigns/:id/stop', async (req, res) => {
    try {
      const { id } = req.params;
      const c = campaigns.get(id);
      if (c) {
        if (c.stop) c.stop(); else if (c.interval) clearInterval(c.interval);
        // Also stop the session
        const sess = sessions.get(c.sessionId);
        if (sess) {
          clearInterval(sess.interval);
          if (sess.bookInterval) clearInterval(sess.bookInterval);
          sess.kalshiWs?.close();
          sess.polyWs?.close();
          sessions.delete(c.sessionId);
        }
        campaigns.delete(id);
      }
      await pool.query(`UPDATE arb_campaigns SET status = 'stopped', stopped_at = NOW(), auto_enabled = false WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Restore running campaigns on startup (runs ONCE) ──
  let _restored = false;
  (async () => {
    if (_restored) return;
    _restored = true;
    try {
      const r = await pool.query("SELECT * FROM arb_campaigns WHERE status = 'running'");
      for (const c of r.rows) {
        // Skip if already running (prevent duplicates)
        if (campaigns.has(c.id)) { console.log(`[arb] Skip restore ${c.id.slice(0,8)} — already running`); continue; }
        console.log(`[arb] Restoring campaign ${c.id.slice(0,8)}: ${c.label || c.kalshi_url?.slice(0,30)}`);
        try {
          const recurringType = c.recurring ? detectRecurringType(c.kalshi_url, c.poly_url) : null;
          let sessionId;

          if (recurringType) {
            const slotResult = await startSlotSession(recurringType);
            if (slotResult) {
              sessionId = slotResult.sessionId;
              await pool.query('UPDATE arb_campaigns SET session_id = $1, kalshi_url = $2, poly_url = $3 WHERE id = $4',
                [slotResult.sessionId, slotResult.kalshiUrl, slotResult.polyUrl, c.id]).catch(() => {});
            }
          } else {
            const sr = await fetch(`http://localhost:${process.env.PORT || 3001}/api/arb/start`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ externalUrl: c.kalshi_url, polymarketSlug: c.poly_url, feeThreshold: 0.02 }),
            });
            const sd = await sr.json();
            sessionId = sd.session?.id;
            if (sessionId) await pool.query('UPDATE arb_campaigns SET session_id = $1 WHERE id = $2', [sessionId, c.id]).catch(() => {});
          }

          if (sessionId && c.auto_enabled) {
            startCampaignAuto(c.id, sessionId, c.auto_threshold_cents || 3, c.auto_cooldown_sec || 60, c.swap_poly || false, c.recurring || false, recurringType, c.early_exit || false, c.exit_threshold_cents || 4);
          }
          console.log(`[arb] Restored campaign ${c.id.slice(0,8)} → session ${sessionId?.slice(0,8) || 'FAILED'} auto=${c.auto_enabled}`);
        } catch (e) {
          console.error(`[arb] Failed to restore campaign ${c.id.slice(0,8)}:`, e.message);
        }
      }
      if (r.rows.length) console.log(`[arb] Restored ${r.rows.length} campaigns`);
      // Clear stale DB locks from previous crashes
      await pool.query(`DELETE FROM arb_locks`).catch(() => {});
      console.log('[arb] Cleared all DB locks');
    } catch (e) {
      console.error('[arb] Campaign restore error:', e.message);
    }
  })();

  /* ── Pre-market snipe: place Poly limit before event, cancel 1s before KS opens, hedge if filled ── */
  app.post('/api/arb/pre-snipe', async (req, res) => {
    try {
      const { asset, side, price, shares } = req.body || {};
      if (!asset || !side || !price || !shares) return res.status(400).json({ error: 'asset, side, price, shares required' });

      const seriesMap = { btc: 'KXBTC15M', eth: 'KXETH15M', sol: 'KXSOL15M', xrp: 'KXXRP15M', hype: 'KXHYPE15M' };
      const series = seriesMap[asset.toLowerCase()];
      if (!series) return res.status(400).json({ error: 'Unknown asset: ' + asset });

      // Find next Poly slot
      const now = Math.floor(Date.now() / 1000);
      const nextSlot = (Math.floor(now / 900) + 1) * 900;
      const slug = `${asset.toLowerCase()}-updown-15m-${nextSlot}`;

      // Get Poly tokens
      const pr = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      const pe = (await pr.json())?.[0];
      if (!pe?.markets?.[0]) return res.status(400).json({ error: 'No Poly market for ' + slug });
      const mkt = pe.markets[0];
      const tids = typeof mkt.clobTokenIds === 'string' ? JSON.parse(mkt.clobTokenIds) : mkt.clobTokenIds;
      const tokenIdx = side === 'up' ? 0 : 1;

      // Place Poly limit order
      const clob = getClobClient?.();
      if (!clob) return res.status(500).json({ error: 'CLOB client not ready' });

      const signed = await clob.createOrder({
        tokenID: tids[tokenIdx],
        price: parseFloat(price),
        size: parseInt(shares),
        side: 'BUY',
      }, { tickSize: '0.01', negRisk: false });
      const polyResult = await clob.postOrder(signed, 'GTC');

      console.log(`[pre-snipe] Placed Poly ${side.toUpperCase()} ${shares}sh @ ${(price*100).toFixed(0)}¢ on ${slug} | order: ${polyResult?.orderID?.slice(0,12)}`);

      // Find Kalshi open time
      const er = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=${series}&limit=3`);
      const events = (await er.json()).events || [];
      let kalshiOpenTime = nextSlot * 1000;
      let kalshiTicker = null;
      for (const e of events) {
        const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${e.event_ticker}&limit=1`);
        const m = (await mr.json()).markets?.[0];
        if (m?.open_time && new Date(m.open_time).getTime() > Date.now()) {
          kalshiOpenTime = new Date(m.open_time).getTime();
          kalshiTicker = m.ticker;
          break;
        }
      }

      res.json({
        ok: true,
        polyOrder: polyResult?.orderID,
        polyStatus: polyResult?.status,
        slug,
        kalshiOpens: new Date(kalshiOpenTime).toISOString(),
        kalshiTicker,
        secsUntilCancel: Math.max(0, (kalshiOpenTime - 1000 - Date.now()) / 1000).toFixed(0),
      });

      // Background: wait, cancel, hedge
      (async () => {
        const orderId = polyResult?.orderID;
        if (!orderId) return;

        // Wait until 1s before Kalshi opens
        const waitMs = kalshiOpenTime - 1000 - Date.now();
        if (waitMs > 0) {
          console.log(`[pre-snipe] Waiting ${(waitMs/1000).toFixed(0)}s before cancel...`);
          await new Promise(r => setTimeout(r, waitMs));
        }

        // Cancel Poly order
        let filledShares = 0;
        try {
          await clob.cancelOrder(orderId);
          console.log(`[pre-snipe] Cancelled Poly order`);
        } catch {}

        // Check fill status
        await new Promise(r => setTimeout(r, 500));
        try {
          const order = await clob.getOrder(orderId);
          filledShares = parseFloat(order?.size_matched || '0');
          console.log(`[pre-snipe] Poly filled: ${filledShares}/${shares}`);
        } catch {
          if (polyResult?.status === 'matched') filledShares = parseInt(shares);
        }

        if (filledShares <= 0) {
          console.log(`[pre-snipe] Not filled. Done.`);
          return;
        }

        // Wait for Kalshi to open
        console.log(`[pre-snipe] Filled ${filledShares}sh! Waiting for Kalshi...`);
        let ksTicker = kalshiTicker;
        for (let i = 0; i < 30 && !ksTicker; i++) {
          await new Promise(r => setTimeout(r, 500));
          const er2 = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=${series}&limit=3&status=open`);
          for (const e of ((await er2.json()).events || [])) {
            const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${e.event_ticker}&limit=1`);
            const m = (await mr.json()).markets?.[0];
            if (m?.status === 'active') { ksTicker = m.ticker; break; }
          }
        }

        if (!ksTicker) {
          console.log(`[pre-snipe] ERROR: Kalshi never opened!`);
          return;
        }

        // Buy opposite on Kalshi
        const oppSide = side === 'up' ? 'no' : 'yes';
        console.log(`[pre-snipe] Hedging: KS ${oppSide.toUpperCase()} ${Math.round(filledShares)}sh at 51¢`);

        const body = { ticker: ksTicker, action: 'buy', side: oppSide, type: 'limit', count: Math.round(filledShares) };
        if (oppSide === 'yes') body.yes_price_dollars = '0.51';
        else body.no_price_dollars = '0.51';

        const kr = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders`, { method: 'POST', body: JSON.stringify(body) });
        const kd = await kr.json();
        if (kr.ok) {
          console.log(`[pre-snipe] HEDGED: KS ${kd.order?.status} filled ${kd.order?.fill_count_fp}`);
        } else {
          console.log(`[pre-snipe] HEDGE FAILED:`, kd.error?.message);
        }
      })();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ── Pre-Market Snipes CRUD ─────────────────────────────────────────────── */

  app.get('/api/arb/snipes', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM arb_snipes ORDER BY created_at DESC');
      res.json({ snipes: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/arb/snipes', async (req, res) => {
    try {
      const { asset, side, limitPrice, shares, kalshiLimit } = req.body || {};
      if (!asset || !side || !limitPrice || !shares) return res.status(400).json({ error: 'asset, side, limitPrice, shares required' });
      const a = asset.toLowerCase();
      const s = side.toLowerCase();
      const validAssets = ['btc', 'eth', 'sol', 'xrp', 'hype'];
      if (!validAssets.includes(a)) return res.status(400).json({ error: 'Unknown asset: ' + asset });
      if (!['up', 'down'].includes(s)) return res.status(400).json({ error: 'side must be up or down' });
      const { rows } = await pool.query(
        'INSERT INTO arb_snipes (asset, side, limit_price, shares, kalshi_limit) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [a, s, parseFloat(limitPrice), parseInt(shares), parseFloat(kalshiLimit || '0.51')],
      );
      res.json({ snipe: rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/arb/snipes/:id', async (req, res) => {
    try {
      // Cancel the Poly order if one exists
      const { rows } = await pool.query('SELECT poly_order_id FROM arb_snipes WHERE id = $1', [req.params.id]);
      if (rows[0]?.poly_order_id) {
        const clob = getClobClient?.();
        if (clob) {
          try { await clob.cancelOrders([rows[0].poly_order_id]); } catch {}
          console.log(`[snipe] Cancelled Poly order ${rows[0].poly_order_id.slice(0,12)} on delete`);
        }
      }
      // Clear in-memory state
      snipeState.delete(req.params.id);
      await pool.query('DELETE FROM arb_snipes WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/arb/snipes/:id', async (req, res) => {
    try {
      const updates = [];
      const vals = [];
      let idx = 1;
      const { active, limitPrice, shares, kalshiLimit } = req.body || {};
      // If pausing, cancel the Poly order
      if (active === false) {
        const { rows } = await pool.query('SELECT poly_order_id FROM arb_snipes WHERE id = $1', [req.params.id]);
        if (rows[0]?.poly_order_id) {
          const clob = getClobClient?.();
          if (clob) {
            try { await clob.cancelOrders([rows[0].poly_order_id]); } catch {}
            console.log(`[snipe] Cancelled Poly order ${rows[0].poly_order_id.slice(0,12)} on pause`);
          }
        }
        snipeState.delete(req.params.id);
      }
      if (active !== undefined) { updates.push(`active = $${idx++}`); vals.push(active); }
      if (limitPrice !== undefined) { updates.push(`limit_price = $${idx++}`); vals.push(parseFloat(limitPrice)); }
      if (shares !== undefined) { updates.push(`shares = $${idx++}`); vals.push(parseInt(shares)); }
      if (kalshiLimit !== undefined) { updates.push(`kalshi_limit = $${idx++}`); vals.push(parseFloat(kalshiLimit)); }
      if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
      vals.push(req.params.id);
      const { rows } = await pool.query(
        `UPDATE arb_snipes SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
        vals,
      );
      res.json({ snipe: rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ── Pre-Market Snipe Manager (background loop) ──────────────────────── */

  const SNIPE_SERIES_MAP = { btc: 'KXBTC15M', eth: 'KXETH15M', sol: 'KXSOL15M', xrp: 'KXXRP15M', hype: 'KXHYPE15M' };

  // Track in-flight state per snipe ID so we don't double-place or double-hedge
  const snipeState = new Map();

  async function runSnipeLoop() {
    let snipes;
    try {
      const { rows } = await pool.query('SELECT * FROM arb_snipes WHERE active = true');
      snipes = rows;
    } catch (e) {
      console.error('[snipe-mgr] DB read error:', e.message);
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const nextSlot = (Math.floor(now / 900) + 1) * 900;
    const secsUntilOpen = nextSlot - now;

    for (const snipe of snipes) {
      const sid = snipe.id;
      if (!snipeState.has(sid)) snipeState.set(sid, {});
      const st = snipeState.get(sid);

      try {
        // Slot rollover: FIRST hedge any filled shares, THEN reset
        if (st.slot && st.slot !== nextSlot) {
          // If we have unfilled Poly order, cancel and check fills
          if (st.polyOrderId && !st.cancelled) {
            st.cancelled = true;
            const clob = getClobClient?.();
            if (clob) {
              try { await clob.cancelOrders([st.polyOrderId]); } catch {}
              try {
                const order = await clob.getOrder(st.polyOrderId);
                const filled = parseFloat(order?.size_matched || '0');
                if (filled > 0) {
                  st.polyFilled = filled;
                  await pool.query('UPDATE arb_snipes SET poly_filled = $1 WHERE id = $2', [filled, sid]);
                }
              } catch {}
            }
          }

          // HEDGE NOW if we have fills but haven't hedged
          if (st.polyFilled > 0 && !st.hedged) {
            st.hedged = true;
            const series = SNIPE_SERIES_MAP[snipe.asset];
            if (series) {
              // The slot that just opened (nextSlot) is the one we need to hedge on
              const hedgeSlot = nextSlot;
              const hedgeDate = new Date(hedgeSlot * 1000);
              // Convert to ET for Kalshi ticker matching
              const etStr = hedgeDate.toLocaleString('en-US', { timeZone: 'America/New_York' });
              const etDate = new Date(etStr);
              const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
              const dd = String(etDate.getDate()).padStart(2, '0');
              const mmm = months[etDate.getMonth()];
              const yy = String(etDate.getFullYear()).slice(2);
              const hh = String(etDate.getHours()).padStart(2, '0');
              const mi = String(etDate.getMinutes()).padStart(2, '0');
              const slotTag = `${yy}${mmm}${dd}${hh}${mi}`.toUpperCase();

              const oppSide = snipe.side === 'up' ? 'no' : 'yes';
              const qty = Math.round(st.polyFilled);
              const ksLimit = parseFloat(snipe.kalshi_limit || '0.51').toFixed(2);
              console.log(`[snipe-mgr] HEDGE on rollover: ${qty}sh KS ${oppSide.toUpperCase()} @ ${(ksLimit*100).toFixed(0)}¢ (slot ${slotTag})`);

              // Poll for KS market to go active
              let ksTicker = null;
              for (let attempt = 0; attempt < 60 && !ksTicker; attempt++) {
                try {
                  const er = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=${series}&limit=5&status=open`);
                  const events = (await er.json()).events || [];
                  for (const e of events) {
                    if (e.event_ticker.includes(slotTag)) {
                      const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${e.event_ticker}&limit=1`);
                      const m = (await mr.json()).markets?.[0];
                      if (m?.status === 'active') { ksTicker = m.ticker; break; }
                    }
                  }
                } catch {}
                if (!ksTicker) await new Promise(r => setTimeout(r, 200));
              }

              if (ksTicker) {
                const body = { ticker: ksTicker, action: 'buy', side: oppSide, type: 'limit', count: qty };
                if (oppSide === 'yes') body.yes_price_dollars = ksLimit;
                else body.no_price_dollars = ksLimit;
                try {
                  const kr = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders`, { method: 'POST', body: JSON.stringify(body) });
                  const kd = await kr.json();
                  console.log(`[snipe-mgr] HEDGED: KS ${oppSide} ${kd.order?.fill_count_fp}/${qty} on ${ksTicker} status: ${kd.order?.status}`);
                  await pool.query("UPDATE arb_snipes SET kalshi_order_id = $1, kalshi_filled = $2, last_result = 'hedged' WHERE id = $3",
                    [kd.order?.order_id, parseFloat(kd.order?.fill_count_fp || '0'), sid]);
                } catch (e) { console.error(`[snipe-mgr] KS hedge error:`, e.message?.slice(0,80)); }
              } else {
                console.log(`[snipe-mgr] ERROR: KS market ${slotTag} never opened!`);
              }
            }
          }

          // NOW reset for next cycle
          console.log(`[snipe-mgr] Slot rollover for ${snipe.asset} ${snipe.side}: ${st.slot} -> ${nextSlot}`);
          st.polyOrderId = null;
          st.hedged = false;
          st.cancelled = false;
          st.polyFilled = 0;
          await pool.query(
            'UPDATE arb_snipes SET current_slot = $1, poly_order_id = NULL, poly_filled = 0, kalshi_filled = 0, kalshi_order_id = NULL, last_result = $2 WHERE id = $3',
            [nextSlot, 'pending', sid],
          );
        }
        st.slot = nextSlot;

        const slug = `${snipe.asset}-updown-15m-${nextSlot}`;

        // Restore state from DB EVERY tick (prevents duplicates after restart)
        {
          const dbSnipe = await pool.query('SELECT * FROM arb_snipes WHERE id = $1', [sid]);
          const dbRow = dbSnipe.rows[0];
          if (dbRow && parseInt(dbRow.current_slot) === nextSlot) {
            if (dbRow.poly_order_id && !st.polyOrderId) st.polyOrderId = dbRow.poly_order_id;
            if (parseInt(dbRow.poly_filled) > 0) st.polyFilled = parseInt(dbRow.poly_filled);
            if (dbRow.kalshi_order_id) st.hedged = true;
            if (['cancelled', 'filled', 'hedged'].includes(dbRow.last_result)) st.cancelled = true;
          }
        }

        // Phase 1: Place Poly GTC order if we don't have one for this slot
        if (!st.polyOrderId && !st.cancelled && secsUntilOpen > 5) {
          // Check total filled for this asset+slot — max 30
          try {
            const capCheck = await pool.query(
              'SELECT COALESCE(SUM(poly_filled), 0) as total FROM arb_snipes WHERE asset = $1 AND current_slot = $2',
              [snipe.asset, nextSlot],
            );
            const totalFilled = parseInt(capCheck.rows[0]?.total || '0');
            if (totalFilled >= 30) {
              console.log(`[snipe-mgr] ${snipe.asset} slot ${nextSlot}: already ${totalFilled}/30 filled — skipping`);
              continue;
            }
          } catch {}

          const clob = getClobClient?.();
          if (!clob) continue;

          // Fetch Poly event to get token IDs
          let tids;
          try {
            const pr = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
            const pe = (await pr.json())?.[0];
            if (!pe?.markets?.[0]) {
              // Market not available yet, skip
              continue;
            }
            const mkt = pe.markets[0];
            tids = typeof mkt.clobTokenIds === 'string' ? JSON.parse(mkt.clobTokenIds) : mkt.clobTokenIds;
          } catch (e) {
            console.error(`[snipe-mgr] Gamma fetch error for ${slug}:`, e.message);
            continue;
          }

          const tokenIdx = snipe.side === 'up' ? 0 : 1;
          try {
            const signed = await clob.createOrder({
              tokenID: tids[tokenIdx],
              price: parseFloat(snipe.limit_price),
              size: parseInt(snipe.shares),
              side: 'BUY',
            }, { tickSize: '0.01', negRisk: false });
            const polyResult = await clob.postOrder(signed, 'GTC');
            const orderId = polyResult?.orderID;

            if (orderId) {
              st.polyOrderId = orderId;
              console.log(`[snipe-mgr] Placed Poly ${snipe.side.toUpperCase()} ${snipe.shares}sh @ ${(snipe.limit_price * 100).toFixed(0)}¢ on ${slug} | order: ${orderId.slice(0, 12)}`);
              await pool.query(
                'UPDATE arb_snipes SET current_slot = $1, poly_order_id = $2, last_result = $3, last_run_at = now() WHERE id = $4',
                [nextSlot, orderId, 'pending', sid],
              );
            }
            // If status is already matched, record it
            if (polyResult?.status === 'matched') {
              st.polyFilled = parseInt(snipe.shares);
              await pool.query('UPDATE arb_snipes SET poly_filled = $1 WHERE id = $2', [st.polyFilled, sid]);
            }
          } catch (e) {
            console.error(`[snipe-mgr] Poly order error for ${snipe.asset} ${snipe.side}:`, e.message);
          }
        }

        // Phase 2: Within 5 seconds of Kalshi open OR slot just rolled over — cancel Poly, check fills, hedge
        // secsUntilOpen uses nextSlot which jumps forward at boundary, so also check if slot JUST changed
        const justRolled = st.slot && st.slot !== nextSlot;
        if (st.polyOrderId && !st.cancelled && (secsUntilOpen <= 5 || justRolled)) {
          st.cancelled = true;
          const clob = getClobClient?.();
          if (!clob) continue;

          let filledShares = 0;

          // Cancel the Poly order
          try {
            await clob.cancelOrder(st.polyOrderId);
            console.log(`[snipe-mgr] Cancelled Poly order ${st.polyOrderId.slice(0, 12)} for ${snipe.asset} ${snipe.side}`);
          } catch (e) {
            console.log(`[snipe-mgr] Cancel error (may already be filled):`, e.message?.slice(0, 80));
          }

          // Check fill status
          try {
            const order = await clob.getOrder(st.polyOrderId);
            filledShares = parseFloat(order?.size_matched || '0');
          } catch {
            // If we can't check, assume none filled unless it was matched at placement
            filledShares = st.polyFilled || 0;
          }

          console.log(`[snipe-mgr] ${snipe.asset} ${snipe.side}: filled ${filledShares}/${snipe.shares}`);
          await pool.query(
            'UPDATE arb_snipes SET poly_filled = $1, last_result = $2, last_run_at = now() WHERE id = $3',
            [filledShares, filledShares > 0 ? 'filled' : 'cancelled', sid],
          );

          if (filledShares <= 0) continue;

          // Phase 3: Hedge on Kalshi — buy opposite side at 99 cents
          if (!st.hedged) {
            st.hedged = true;

            const series = SNIPE_SERIES_MAP[snipe.asset];
            if (!series) continue;

            // Find the Kalshi market for the NEXT slot (not the current expiring one)
            // The next slot timestamp should be in the event ticker
            const nextSlotTs = nextSlot;
            const nextSlotDate = new Date(nextSlotTs * 1000);
            // Convert to ET for Kalshi ticker matching
            const etStr2 = nextSlotDate.toLocaleString('en-US', { timeZone: 'America/New_York' });
            const etDate2 = new Date(etStr2);
            const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
            const dd = String(etDate2.getDate()).padStart(2, '0');
            const mmm = months[etDate2.getMonth()];
            const yy = String(etDate2.getFullYear()).slice(2);
            const hh = String(etDate2.getHours()).padStart(2, '0');
            const mi = String(etDate2.getMinutes()).padStart(2, '0');
            const slotTag = `${yy}${mmm}${dd}${hh}${mi}`.toUpperCase();
            console.log(`[snipe-mgr] Looking for KS event matching slot ${slotTag}`);

            let ksTicker = null;
            for (let attempt = 0; attempt < 60 && !ksTicker; attempt++) {
              try {
                const er = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=${series}&limit=5&status=open`);
                const events = (await er.json()).events || [];
                for (const e of events) {
                  // Match event ticker to our slot (e.g. KXBTC15M-26MAR282330)
                  if (e.event_ticker.includes(slotTag)) {
                    const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${e.event_ticker}&limit=1`);
                    const m = (await mr.json()).markets?.[0];
                    if (m?.status === 'active') { ksTicker = m.ticker; break; }
                  }
                }
              } catch {}
              if (!ksTicker) await new Promise(r => setTimeout(r, 200)); // fast poll for KS open
            }

            if (!ksTicker) {
              console.log(`[snipe-mgr] ERROR: Kalshi never opened for ${snipe.asset}!`);
              await pool.query("UPDATE arb_snipes SET last_result = 'error_no_kalshi', last_run_at = now() WHERE id = $1", [sid]);
              continue;
            }

            const oppSide = snipe.side === 'up' ? 'no' : 'yes';
            const qty = Math.round(filledShares);
            const ksLimit = parseFloat(snipe.kalshi_limit || '0.51').toFixed(2);
            console.log(`[snipe-mgr] Hedging: KS ${oppSide.toUpperCase()} ${qty}sh @ ${(ksLimit*100).toFixed(0)}¢ on ${ksTicker}`);

            const body = { ticker: ksTicker, action: 'buy', side: oppSide, type: 'limit', count: qty };
            if (oppSide === 'yes') body.yes_price_dollars = ksLimit;
            else body.no_price_dollars = ksLimit;

            try {
              const kr = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders`, { method: 'POST', body: JSON.stringify(body) });
              const kd = await kr.json();
              if (kr.ok) {
                console.log(`[snipe-mgr] HEDGED: ${kd.order?.status} filled ${kd.order?.fill_count_fp}`);
                await pool.query(
                  'UPDATE arb_snipes SET kalshi_filled = $1, kalshi_order_id = $2, last_result = $3, last_run_at = now() WHERE id = $4',
                  [kd.order?.fill_count_fp || qty, kd.order?.order_id, 'hedged', sid],
                );
              } else {
                console.log(`[snipe-mgr] HEDGE FAILED:`, kd.error?.message || JSON.stringify(kd));
                await pool.query("UPDATE arb_snipes SET last_result = $1, last_run_at = now() WHERE id = $2", [`hedge_failed: ${kd.error?.message || 'unknown'}`, sid]);
              }
            } catch (e) {
              console.error(`[snipe-mgr] Kalshi order error:`, e.message);
              await pool.query("UPDATE arb_snipes SET last_result = $1, last_run_at = now() WHERE id = $2", [`hedge_error: ${e.message}`, sid]);
            }
          }
        }
      } catch (e) {
        console.error(`[snipe-mgr] Error processing snipe ${sid}:`, e.message);
      }
    }
  }

  // Run snipe manager every 5 seconds
  // Adaptive speed: 200ms near hedge time, 5s otherwise
  let snipeRunning = false;
  async function snipeTick() {
    if (snipeRunning) { setTimeout(snipeTick, 200); return; }
    snipeRunning = true;
    try { await runSnipeLoop(); } catch (e) { console.error('[snipe-mgr] error:', e.message?.slice(0,80)); }
    snipeRunning = false;
    const now = Math.floor(Date.now() / 1000);
    const nextSlot = (Math.floor(now / 900) + 1) * 900;
    const secsToNext = nextSlot - now;
    // Fast poll within 10s of slot boundary
    const delay = secsToNext <= 10 ? 200 : 5000;
    setTimeout(snipeTick, delay);
  }
  setTimeout(snipeTick, 1000);
  console.log('[snipe-mgr] Pre-market snipe manager started (adaptive: 200ms near open, 5s otherwise)');

  /* ── Balance tracker: snapshot every 15 min, compute real P&L from baseline ── */
  const BASELINE = 1122.80;

  async function snapshotBalance() {
    try {
      const { kalshiFetch: kf } = await import('./kalshiAuth.mjs');
      const { JsonRpcProvider } = await import('@ethersproject/providers');
      const { Contract } = await import('@ethersproject/contracts');

      // Kalshi
      const br = await kf(`${KALSHI_TRADE_API.replace('/trade-api/v2', '')}/trade-api/v2/portfolio/balance`);
      const b = await br.json();
      const ksBal = b.balance / 100;
      const ksPf = b.portfolio_value / 100;

      // Poly USDC
      const provider = new JsonRpcProvider(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`);
      const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];
      const funder = process.env.FUNDER_ADDRESS;
      const usdcE = new Contract('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', USDC_ABI, provider);
      const usdcN = new Contract('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', USDC_ABI, provider);
      const [balE, balN] = await Promise.all([usdcE.balanceOf(funder), usdcN.balanceOf(funder)]);
      const polyUSDC = Number(balE) / 1e6 + Number(balN) / 1e6;

      // Poly positions
      const posRes = await fetch(`https://data-api.polymarket.com/positions?user=${funder.toLowerCase()}&limit=200`);
      const positions = await posRes.json();
      let polyPos = 0;
      for (const p of (positions || [])) polyPos += p.currentValue || 0;

      const total = ksBal + ksPf + polyUSDC + polyPos;
      const profit = total - BASELINE;

      await pool.query(
        'INSERT INTO arb_balance_snapshots (kalshi_balance, kalshi_portfolio, poly_usdc, poly_positions, total, profit) VALUES ($1,$2,$3,$4,$5,$6)',
        [ksBal, ksPf, polyUSDC, polyPos, total, profit],
      );
      console.log(`[balance] Snapshot: KS $${ksBal.toFixed(0)} + Poly $${(polyUSDC + polyPos).toFixed(0)} = $${total.toFixed(2)} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
    } catch (e) {
      console.error('[balance] Snapshot error:', e.message?.slice(0, 100));
    }
  }

  // Snapshot every 15 min
  setTimeout(snapshotBalance, 10000);
  setInterval(snapshotBalance, 15 * 60 * 1000);

  // API endpoint for current + historical P&L
  app.get('/api/arb/pnl', async (req, res) => {
    try {
      // Latest snapshot
      const latest = await pool.query('SELECT * FROM arb_balance_snapshots ORDER BY ts DESC LIMIT 1');
      // History
      const history = await pool.query('SELECT ts, total, profit FROM arb_balance_snapshots ORDER BY ts DESC LIMIT 100');
      res.json({
        baseline: BASELINE,
        current: latest.rows[0] || null,
        history: history.rows,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[arb] Routes registered (Postgres OK, WS-driven)');
}
