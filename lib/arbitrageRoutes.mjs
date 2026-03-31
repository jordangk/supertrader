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

function polyTfMinutesFromSlug(slug) {
  const m = String(slug || '').toLowerCase().match(/-updown-(\d+)m-/);
  const tf = m?.[1] ? parseInt(m[1], 10) : null;
  return Number.isFinite(tf) ? tf : null;
}

function sameLeadingDirection(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  // 40-60 is treated as neutral tolerance band for 5m.
  if ((a >= 0.4 && a <= 0.6) || (b >= 0.4 && b <= 0.6)) return true;
  return (a > 0.5 && b > 0.5) || (a < 0.5 && b < 0.5);
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

/** Poly unix (UTC) → Kalshi slot tag e.g. 26MAR301315 (ET wall clock tag). */
function polyUnixToKalshiSlotTag(unixSec) {
  const etStr = new Date(unixSec * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etStr);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const dd = String(etDate.getDate()).padStart(2, '0');
  const mmm = months[etDate.getMonth()];
  const yy = String(etDate.getFullYear()).slice(2);
  const hh = String(etDate.getHours()).padStart(2, '0');
  const mi = String(etDate.getMinutes()).padStart(2, '0');
  return `${yy}${mmm}${dd}${hh}${mi}`.toUpperCase();
}

/** Kalshi ticker fragment e.g. 26MAR301315 → unix seconds for that ET wall time (Poly slug uses 15m UTC slots). */
function kalshiSlotTagToPolyUnix(slotTag) {
  const m = String(slotTag).match(/^(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{2})(\d{2})$/i);
  if (!m) return null;
  const yy = parseInt(m[1], 10);
  const mon = m[2].toUpperCase();
  const dd = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const year = 2000 + yy;
  const monthMap = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  const month = monthMap[mon];
  if (!month) return null;
  const target = { y: year, mo: month, d: dd, h: hour, mi: minute };
  const lo = Date.UTC(year, month - 1, dd, 0, 0, 0) - 12 * 3600 * 1000;
  const hi = Date.UTC(year, month - 1, dd, 0, 0, 0) + 36 * 3600 * 1000;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  for (let t = lo; t <= hi; t += 60 * 1000) {
    const d = new Date(t);
    const parts = dtf.formatToParts(d);
    const y = parseInt(parts.find((p) => p.type === 'year')?.value, 10);
    const mo = parseInt(parts.find((p) => p.type === 'month')?.value, 10);
    const day = parseInt(parts.find((p) => p.type === 'day')?.value, 10);
    const hr = parseInt(parts.find((p) => p.type === 'hour')?.value, 10);
    const min = parseInt(parts.find((p) => p.type === 'minute')?.value, 10);
    if (y === target.y && mo === target.mo && day === target.d && hr === target.h && min === target.mi) {
      return Math.floor(t / 1000);
    }
  }
  return null;
}

/** Extract normalized slot tag from KX*15M tickers (drop trailing "-15"/"-30" if present). */
function extractKalshiCryptoSlotTag(ticker) {
  const u = String(ticker).toUpperCase();
  const idx = u.indexOf('M-');
  if (idx === -1) return null;
  const tail = u.slice(idx + 2) || '';
  const m = tail.match(/^(\d{2}[A-Z]{3}\d{2}\d{4})/);
  return m ? m[1] : (tail || null);
}

/**
 * Kalshi API `event_ticker` for crypto N-minute markets is two segments: KXBTC15M-26MAR301400.
 * The tradable **market** ticker adds a numeric suffix: KXBTC15M-26MAR301400-15.
 * Stripping only /-[A-Z]+$/ misses `-15` and breaks ?event_ticker= queries + allKalshiMarkets.
 */
function kalshiEventTickerFromMarketTicker(ticker) {
  const t = String(ticker || '').toUpperCase();
  const parts = t.split('-');
  if (parts.length >= 3 && /^KX[A-Z]+\d+M$/i.test(parts[0])) {
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last) && last.length <= 4) {
      return parts.slice(0, -1).join('-');
    }
  }
  return t.replace(/-[A-Z]+$/i, '');
}

/**
 * Poly slug epoch and Kalshi KX*15M ticker must agree on the same 15m close mark.
 * Poly slug uses window start epoch, while Kalshi ticker tag encodes window close.
 */
function checkCrypto15mKalshiPolyPairing(kalshiTicker, polySlug) {
  if (!kalshiTicker || !polySlug) return { ok: true };
  const slug = String(polySlug).trim();
  for (const cm of CRYPTO_SLOT_MAP) {
    const m = slug.match(cm.polyRe);
    if (!m) continue;
    const tf = m[1];
    // This validator is only for strict 15m-vs-15m slot parity.
    // Mixed timeframe setups (e.g., Kalshi 15m vs Poly 5m) are intentionally allowed.
    if (String(tf) !== '15') return { ok: true };
    const polyUnix = parseInt(m[2], 10);
    const series = `${cm.kalshiSeries}${tf}M`.toUpperCase();
    const kt = String(kalshiTicker).toUpperCase();
    if (!kt.startsWith(series)) {
      return {
        ok: false,
        reason: 'series_mismatch',
        polyUnix,
        message: `Polymarket is ${cm.asset} ${tf}m but Kalshi ticker ${kalshiTicker} is not series ${series}.`,
      };
    }
    const closeUnix = polyUnix + parseInt(tf, 10) * 60;
    const expectedTag = polyUnixToKalshiSlotTag(closeUnix);
    const actualTag = extractKalshiCryptoSlotTag(kalshiTicker);
    if (!actualTag) {
      return {
        ok: false,
        reason: 'kalshi_slot_parse',
        polyUnix,
        expectedKalshiSlotTag: expectedTag,
        message: `Could not read slot from Kalshi ticker (expected …-${expectedTag} for slug epoch ${polyUnix}).`,
      };
    }
    if (actualTag !== expectedTag) {
      return {
        ok: false,
        reason: 'slot_mismatch',
        polyUnix,
        expectedKalshiSlotTag: expectedTag,
        kalshiSlotTag: actualTag,
        message: `Wrong Kalshi window: Polymarket ${slug} uses epoch ${polyUnix} → Kalshi slot ${expectedTag}, but ticker ends with ${actualTag}. Same arb needs KX…15M-${expectedTag} (not ${actualTag}).`,
      };
    }
    return { ok: true, polyUnix, kalshiSlotTag: actualTag };
  }
  return { ok: true };
}

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
      const timestamp = m[2]; // unix seconds (Poly 15m slot start, UTC-aligned)
      // Find matching Kalshi event by close mark (Poly slug epoch is window start).
      const series = `${cm.kalshiSeries}${timeframe}M`;
      const startUnix = parseInt(timestamp, 10);
      const closeUnix = startUnix + parseInt(timeframe, 10) * 60;
      const slotTag = polyUnixToKalshiSlotTag(closeUnix);
      try {
        const r = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=${series}&limit=100`);
        const d = await r.json();
        const events = d.events || [];
        const ev = events.find((e) => e.event_ticker?.toUpperCase().includes(slotTag));
        if (!ev) continue;
        const evTicker = ev.event_ticker;
        const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${encodeURIComponent(evTicker)}&limit=5`);
        const md = await mr.json();
        const market = md.markets?.[0];
        return {
          kalshiUrl: `https://kalshi.com/markets/${series.toLowerCase()}/${evTicker.toLowerCase()}`,
          kalshiTicker: market?.ticker || evTicker,
          polyUrl: normalizeFetchUrl(inputUrl),
          kalshiTitle: market?.title || ev.title,
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
      const slotTag = extractKalshiCryptoSlotTag(ticker);
      // Kalshi tag is close mark; convert to Poly slug start epoch.
      let closeUnix = slotTag ? kalshiSlotTagToPolyUnix(slotTag) : null;
      // Get Kalshi title + optional open_time fallback for Poly slug
      let kalshiTitle = ticker;
      try {
        const r = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(ticker)}`);
        const d = await r.json();
        kalshiTitle = d.market?.title || ticker;
        if (closeUnix == null && d.market?.open_time) {
          // Fallback: open_time can be treated as close marker for these 15m binaries.
          closeUnix = Math.floor(new Date(d.market.open_time).getTime() / 1000);
        }
      } catch {}
      if (closeUnix == null) continue;
      const slotSec = parseInt(timeframe, 10) * 60;
      closeUnix = Math.floor(closeUnix / slotSec) * slotSec;
      let startUnix = closeUnix - slotSec;
      startUnix = Math.floor(startUnix / slotSec) * slotSec;
      const polySlug = `${cm.asset}-updown-${timeframe}m-${startUnix}`;
      const polyUrl = `https://polymarket.com/event/${polySlug}`;
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
    const raw = extractKalshiTicker(inputUrl);
    kalshiEventTicker = raw ? kalshiEventTickerFromMarketTicker(raw) : null;
    polySlug = match.slug;
  } else {
    kalshiEventTicker = kalshiEventTickerFromMarketTicker(match.ticker);
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
  /**
   * Kalshi connectivity: RSA auth, GET /portfolio/balance, optional market snapshot.
   * Does not require Postgres. Call: GET /api/arb/kalshi-test?ticker=KXBTC15M-...
   */
  app.get('/api/arb/kalshi-test', async (req, res) => {
    const tickerQ = req.query.ticker ? String(req.query.ticker).trim() : '';
    const maskKey = (k) => (k && k.length > 6 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k ? '(set)' : '');
    const env = {
      KALSHI_API_BASE: process.env.KALSHI_API_BASE || '(default elections.kalshi.com)',
      apiKey: maskKey(process.env.KALSHI_API_KEY || ''),
      privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH ? '(set)' : '',
      privateKeyInline: process.env.KALSHI_PRIVATE_KEY ? '(set)' : '',
      rsaAuthReady: hasKalshiAuth(),
    };

    const steps = [];

    async function probe(name, url) {
      const r = await kalshiFetch(url);
      const text = await r.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {
        j = { raw: text.slice(0, 300) };
      }
      const errMsg = j?.error?.message || j?.message || (r.ok ? null : text.slice(0, 200));
      steps.push({
        step: name,
        url: url.replace(/^(https?:\/\/[^/]+).*/, '$1…'),
        httpStatus: r.status,
        ok: r.ok,
        error: errMsg || undefined,
        summary: r.ok && name === 'balance' && j?.balance != null
          ? `balance ${j.balance}¢ portfolio_value ${j.portfolio_value ?? '—'}¢`
          : r.ok && name === 'events_open' && j?.events?.[0]
            ? `open event ${j.events[0].event_ticker}`
            : r.ok && name === 'market' && j?.market
              ? `status=${j.market.status} yes_ask=${j.market.yes_ask_dollars} no_ask=${j.market.no_ask_dollars}`
              : undefined,
      });
      return { r, j };
    }

    try {
      await probe('balance', `${KALSHI_TRADE_API}/portfolio/balance`);
      await probe('events_open', `${KALSHI_TRADE_API}/events?series_ticker=KXBTC15M&status=open&limit=3`);

      if (tickerQ) {
        await probe('market', `${KALSHI_TRADE_API}/markets/${encodeURIComponent(tickerQ)}`);
      }

      const balanceStep = steps.find((s) => s.step === 'balance');
      const healthy = env.rsaAuthReady && balanceStep?.ok === true;

      res.json({
        ok: healthy,
        message: healthy
          ? 'Kalshi API auth + balance OK — trading stack can reach Kalshi.'
          : !env.rsaAuthReady
            ? 'RSA signing not ready: set KALSHI_API_KEY + KALSHI_PRIVATE_KEY_PATH (or KALSHI_PRIVATE_KEY).'
            : balanceStep?.httpStatus === 401
              ? '401 on balance — bad API key or signature (check key file matches Kalshi dashboard).'
              : (balanceStep?.error || 'Balance request failed — see steps.'),
        baseUrl: KALSHI_TRADE_API,
        env,
        steps,
        hint: 'CLI: npm run test:kalshi — or curl same host GET /api/arb/kalshi-test',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, env, steps });
    }
  });

  /**
   * One-shot arb debugging: Kalshi auth, live sessions, recent campaigns.
   * GET /api/arb/debug
   */
  app.get('/api/arb/debug', async (req, res) => {
    const out = {
      ts: new Date().toISOString(),
      kalshi: { rsaReady: hasKalshiAuth(), balanceHttp: null, balanceError: null },
      postgres: Boolean(pool),
      inMemorySessions: { count: sessions.size, ids: [...sessions.keys()].slice(0, 12) },
      campaigns: [],
      recentSessions: [],
      hints: [
        'Auto-trading only runs when a campaign status=running and auto_enabled=true (see campaigns below).',
        'Clicking Stop on Arb Lab ends the in-memory session — Start again to get a new session id.',
        'Campaign auto-stops after 3 Polymarket leg failures in a row (see server log: "3 Poly failures — STOPPING").',
        'npm run test:kalshi — verify Kalshi credentials without the UI.',
      ],
    };
    try {
      const br = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/balance`);
      out.kalshi.balanceHttp = br.status;
      if (!br.ok) {
        const t = await br.text();
        try {
          const j = JSON.parse(t);
          out.kalshi.balanceError = j?.error?.message || j?.message || t.slice(0, 200);
        } catch {
          out.kalshi.balanceError = t.slice(0, 200);
        }
      }
    } catch (e) {
      out.kalshi.balanceError = e.message;
    }
    if (pool) {
      try {
        const cr = await pool.query(
          `SELECT * FROM arb_campaigns ORDER BY created_at DESC LIMIT 15`,
        );
        out.campaigns = cr.rows;
        const sr = await pool.query(
          `SELECT id, polymarket_slug, ended_at, created_at, external_url FROM arb_sessions ORDER BY created_at DESC LIMIT 10`,
        );
        out.recentSessions = sr.rows;
      } catch (e) {
        out.dbError = e.message;
      }
    }
    res.json(out);
  });

  if (!pool) {
    console.warn('[arb] Postgres not configured (set ARB_DATABASE_URL or DB_*). Arb API disabled.');
    app.post('/api/arb/start', (req, res) => res.status(503).json({ error: 'Database not configured' }));
    app.post('/api/arb/stop/:id', (req, res) => res.status(503).json({ error: 'Database not configured' }));
    app.get('/api/arb/session/:id', (req, res) => res.status(503).json({ error: 'Database not configured' }));
    app.get('/api/arb/sessions', (req, res) => res.status(503).json({ error: 'Database not configured' }));
    app.post('/api/arb/session/:id/venue-pnl', (req, res) => res.status(503).json({ error: 'Database not configured' }));
    return;
  }

  // Lightweight schema bootstrap for newer campaign controls.
  pool.query("ALTER TABLE arb_campaigns ADD COLUMN IF NOT EXISTS max_shares INT NOT NULL DEFAULT 50")
    .catch((e) => console.warn('[arb] schema bootstrap (max_shares):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_campaigns ALTER COLUMN max_shares SET DEFAULT 50")
    .catch((e) => console.warn('[arb] schema bootstrap (max_shares default):', e.message?.slice(0, 120)));
  // Venue P&L columns (auto-bootstrap to avoid manual SQL step).
  pool.query("ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_kalshi NUMERIC")
    .catch((e) => console.warn('[arb] schema bootstrap (venue_pnl_kalshi):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_polymarket NUMERIC")
    .catch((e) => console.warn('[arb] schema bootstrap (venue_pnl_polymarket):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_total NUMERIC")
    .catch((e) => console.warn('[arb] schema bootstrap (venue_pnl_total):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_status TEXT")
    .catch((e) => console.warn('[arb] schema bootstrap (venue_pnl_status):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_detail JSONB")
    .catch((e) => console.warn('[arb] schema bootstrap (venue_pnl_detail):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_computed_at TIMESTAMPTZ")
    .catch((e) => console.warn('[arb] schema bootstrap (venue_pnl_computed_at):', e.message?.slice(0, 120)));
  // Persist book-size context per trade for slippage analysis.
  pool.query("ALTER TABLE arb_trades ADD COLUMN IF NOT EXISTS signal_ks_yes_ask_qty NUMERIC")
    .catch((e) => console.warn('[arb] schema bootstrap (signal_ks_yes_ask_qty):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_trades ADD COLUMN IF NOT EXISTS signal_ks_no_ask_qty NUMERIC")
    .catch((e) => console.warn('[arb] schema bootstrap (signal_ks_no_ask_qty):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_trades ADD COLUMN IF NOT EXISTS signal_poly_up_ask_qty NUMERIC")
    .catch((e) => console.warn('[arb] schema bootstrap (signal_poly_up_ask_qty):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_trades ADD COLUMN IF NOT EXISTS signal_poly_down_ask_qty NUMERIC")
    .catch((e) => console.warn('[arb] schema bootstrap (signal_poly_down_ask_qty):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_trades ADD COLUMN IF NOT EXISTS signal_poly_up_depth_2c NUMERIC")
    .catch((e) => console.warn('[arb] schema bootstrap (signal_poly_up_depth_2c):', e.message?.slice(0, 120)));
  pool.query("ALTER TABLE arb_trades ADD COLUMN IF NOT EXISTS signal_poly_down_depth_2c NUMERIC")
    .catch((e) => console.warn('[arb] schema bootstrap (signal_poly_down_depth_2c):', e.message?.slice(0, 120)));

  const GLOBAL_MAX_SHARES = 50;

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

    // Prefer best ask (what you pay to buy each side) — matches Kalshi.com order panel. Mid-only was misleading vs the site.
    if (kalshiCache.yesAsk != null || kalshiCache.noAsk != null || kalshiCache.yesBid != null || kalshiCache.last != null) {
      extPrice = kalshiCache.yesAsk
        ?? kalshiCache.last
        ?? (kalshiCache.yesBid != null && kalshiCache.yesAsk != null ? (kalshiCache.yesBid + kalshiCache.yesAsk) / 2 : null)
        ?? kalshiCache.yesBid;
      extNo = kalshiCache.noAsk
        ?? (kalshiCache.noBid != null && kalshiCache.noAsk != null ? (kalshiCache.noBid + kalshiCache.noAsk) / 2 : null);
      if (extNo == null && extPrice != null) extNo = 1 - extPrice;
    } else if (kalshiCache.ticker) {
      errExt = 'Waiting for book data...';
    } else {
      // Poly+Poly sessions intentionally have no Kalshi leg.
      errExt = kalshiCache.error || null;
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
      const bothPolyInput = looksPolymarketUrl(String(externalUrl)) && looksPolymarketUrl(String(polymarketSlug));
      const fee = Math.min(0.5, Math.max(0, parseFloat(feeThreshold) || 0.02));
      let extUrl = normalizeFetchUrl(String(externalUrl).trim());
      let polyRaw = normalizeFetchUrl(String(polymarketSlug).trim());

      if (looksPolymarketUrl(extUrl) && !extractKalshiTicker(extUrl) && !bothPolyInput) {
        if (looksKalshiInput(polyRaw)) {
          [extUrl, polyRaw] = [polyRaw, extUrl];
        } else if (looksPolymarketUrl(polyRaw)) {
          // Poly + Poly input mode:
          // - If Kalshi field contains a Poly link, treat it as the active Poly market
          //   (same Poly flow/parsing as normal Polymarket input).
          // - Second field is kept as optional reference.
          // - Kalshi side defaults to current BTC 15m market
          polyRaw = extUrl;
          let inferredKalshi = null;
          try {
            const er = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=KXBTC15M&limit=3&status=open`);
            const ed = await er.json();
            const ev = ed?.events?.[0];
            if (ev?.event_ticker) {
              const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${encodeURIComponent(ev.event_ticker)}&limit=5`);
              const md = await mr.json();
              const mkt = (md?.markets || []).find((m) => m.status === 'active') || md?.markets?.[0];
              inferredKalshi = mkt?.ticker || ev.event_ticker || null;
            }
          } catch {}
          if (!inferredKalshi) {
            return res.status(400).json({
              error:
                'Could not resolve default Kalshi BTC15m market for Poly+Poly input. Try again in a few seconds or paste a Kalshi link in the first field.',
            });
          }
          extUrl = inferredKalshi;
        } else {
          // Accept Poly in first field too: infer Kalshi from either pasted Poly URL.
          let inferredKalshi = null;
          try {
            inferredKalshi = (await tryCryptoSlotMatch(extUrl))?.kalshiTicker || null;
          } catch {}
          if (!inferredKalshi) {
            try {
              inferredKalshi = (await tryCryptoSlotMatch(polyRaw))?.kalshiTicker || null;
            } catch {}
          }
          if (!inferredKalshi) {
            // Fallback: allow both fields to be Polymarket by defaulting Kalshi to current BTC 15m.
            // This supports "Kalshi BTC15m vs Poly BTC/ETH 5m" workflows.
            try {
              const er = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=KXBTC15M&limit=3&status=open`);
              const ed = await er.json();
              const ev = ed?.events?.[0];
              if (ev?.event_ticker) {
                const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${encodeURIComponent(ev.event_ticker)}&limit=5`);
                const md = await mr.json();
                const mkt = (md?.markets || []).find((m) => m.status === 'active') || md?.markets?.[0];
                inferredKalshi = mkt?.ticker || ev.event_ticker || null;
              }
            } catch {}
          }
          if (!inferredKalshi) {
            return res.status(400).json({
              error:
                'Could not infer Kalshi from the pasted links. Paste one Kalshi + one Polymarket link, or use a crypto up/down Poly link that can be auto-matched.',
            });
          }
          const polyKeep = extractPolymarketSlug(polyRaw) ? polyRaw : extUrl;
          extUrl = inferredKalshi;
          polyRaw = polyKeep;
        }
      }

      const polySlug = extractPolymarketSlug(polyRaw);
      const polySlugAlt = bothPolyInput ? extractPolymarketSlug(extUrl) : null;
      const polyTfMin = polyTfMinutesFromSlug(polySlug);
      const polyTfAltMin = polyTfMinutesFromSlug(polySlugAlt);

      // Resolve both sides in parallel (or dual-poly when both inputs are Polymarket)
      const [kalshiResult, polyResult, polyResultAlt] = await Promise.all([
        bothPolyInput
          ? Promise.resolve({ ticker: null, initial: { price: null, error: 'poly_only_mode' } })
          : resolveKalshiTicker(extUrl),
        resolvePolyTokens(polySlug),
        bothPolyInput ? resolvePolyTokens(polySlugAlt) : Promise.resolve(null),
      ]);

      const kalshiTicker = kalshiResult.ticker;
      const polyTokens = polyResult.tokens;
      const polyTokensAlt = polyResultAlt?.tokens || [];

      // Resolve ALL Kalshi markets in this event (for 2-market events like NBA/NHL)
      let allKalshiMarkets = [];
      if (kalshiTicker) {
        const eventTicker = kalshiEventTickerFromMarketTicker(kalshiTicker);
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
          if (allKalshiMarkets.length === 0) {
            console.warn(`[arb-start] Kalshi event_ticker=${eventTicker} returned 0 markets (resolved from market ticker ${kalshiTicker})`);
          }
        } catch (e) {
          console.warn(`[arb-start] Kalshi markets?event_ticker failed:`, e.message?.slice(0, 120));
        }
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
        updated: 0, error: bothPolyInput ? null : (kalshiResult.initial?.error || null),
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
      const polyCacheAlt = {
        up: polyResultAlt?.up ?? null,
        down: polyResultAlt?.down ?? null,
        tokens: polyTokensAlt || [],
        updated: polyResultAlt?.up != null ? Date.now() : 0,
        error: polyResultAlt?.error || null,
      };

      // Connect websockets
      let kalshiWs = null;
      if (kalshiTicker) {
        kalshiWs = connectKalshiWs(kalshiTicker, kalshiCache, id.slice(0, 8));
      }

      let polyWsPrimary = null;
      if (polyTokens?.length) {
        polyWsPrimary = connectPolyWs(polyTokens, polyCache, id.slice(0, 8));
      }
      let polyWsAlt = null;
      if (bothPolyInput && polyTokensAlt?.length) {
        polyWsAlt = connectPolyWs(polyTokensAlt, polyCacheAlt, `${id.slice(0, 8)}-alt`);
      }
      const polyWs = {
        close() {
          try { polyWsPrimary?.close(); } catch {}
          try { polyWsAlt?.close(); } catch {}
        },
      };

      // Write first tick immediately
      writeTick(id, fee, kalshiCache, polyCache);

      // 500ms interval reads from WS caches
      const iv = setInterval(() => writeTick(id, fee, kalshiCache, polyCache), 500);

      // 2s background book cache updater (Kalshi rate limit is ~10 req/s)
      const bookCache = { data: null, updated: 0 };
      const allTickers = allKalshiMarkets.length > 1 ? allKalshiMarkets.map(m => m.ticker) : (kalshiTicker ? [kalshiTicker] : []);
      const bookIv = setInterval(async () => {
        try {
          // Kalshi: market + orderbook for primary, market only for others — 1 per second
          const [mktRes, obRes] = kalshiTicker
            ? await Promise.all([
              kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(kalshiTicker)}`).catch(() => null),
              kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(kalshiTicker)}/orderbook`).catch(() => null),
            ])
            : [null, null];

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

          // Official market snapshot — prefer over orderbook-implied crosses (matches Kalshi web UI / ticket prices).
          let ksExpiration = null;
          if (mktRes?.ok) {
            const md = (await mktRes.json()).market;
            if (md) {
              ksExpiration = md.expiration_time || md.close_time || null;
              const ya = parseFloat(md.yes_ask_dollars); const na = parseFloat(md.no_ask_dollars);
              const yb = parseFloat(md.yes_bid_dollars); const nb = parseFloat(md.no_bid_dollars);
              if (!Number.isNaN(ya) && ya > 0) ksYesAsk = ya;
              if (!Number.isNaN(na) && na > 0) ksNoAsk = na;
              if (!Number.isNaN(yb) && yb > 0) ksYesBid = yb;
              if (!Number.isNaN(nb) && nb > 0) ksNoBid = nb;
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
                  depthAt2c: asks.filter(l => parseFloat(l.price) <= parseFloat(asks[0].price) + 0.02).reduce((s, l) => s + parseFloat(l.size), 0),
                };
              }
            }
          }
          let polyBookAlt = { up: null, down: null };
          if (bothPolyInput && polyTokensAlt?.length >= 2) {
            const [upBookAlt, downBookAlt] = await Promise.all(
              polyTokensAlt.map(tid =>
                fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tid)}`)
                  .then(r => r.json()).catch(() => null)
              ),
            );
            for (const [book, key] of [[upBookAlt, 'up'], [downBookAlt, 'down']]) {
              if (book?.asks?.length) {
                const asks = book.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
                const bids = (book.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
                polyBookAlt[key] = {
                  bestAsk: parseFloat(asks[0].price), bestAskQty: parseFloat(asks[0].size),
                  bestBid: bids[0] ? parseFloat(bids[0].price) : null, bestBidQty: bids[0] ? parseFloat(bids[0].size) : null,
                  depthAt1c: asks.filter(l => parseFloat(l.price) <= parseFloat(asks[0].price) + 0.01).reduce((s, l) => s + parseFloat(l.size), 0),
                  depthAt2c: asks.filter(l => parseFloat(l.price) <= parseFloat(asks[0].price) + 0.02).reduce((s, l) => s + parseFloat(l.size), 0),
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
            polyA: bothPolyInput ? polyBookAlt : undefined,
            polyB: bothPolyInput ? polyBook : undefined,
            updated: { kalshi: Date.now(), poly: Date.now() },
          };
          bookCache.updated = Date.now();
        } catch {}
      }, 2000); // 2s — multiple campaigns share the rate limit

      sessions.set(id, {
        interval: iv, bookInterval: bookIv, bookCache, kalshiWs, polyWs, kalshiCache, polyCache,
        kalshiTicker, allKalshiMarkets, polyTokens: polyTokens || [],
        polyTokensAlt: polyTokensAlt || [],
        polyTfMin,
        polyTfAltMin,
        polySlugAlt,
        polyOutcomes: polyResult.outcomes || ['Up', 'Down'],
        polyOutcomesAlt: polyResultAlt?.outcomes || ['Up', 'Down'],
        polyOnlyInput: bothPolyInput,
        negRisk: polyResult.negRisk || false,
        negRiskAlt: polyResultAlt?.negRisk || false,
        tickSize: '0.01',
        fee,
      });

      const pairing = checkCrypto15mKalshiPolyPairing(kalshiTicker, polySlug);
      if (!pairing.ok) {
        console.warn(`[arb-start] PAIRING WARNING session=${id.slice(0, 8)}`, pairing.message, pairing);
      }

      res.json({
        session,
        meta: {
          kalshiTicker,
          kalshiEventTicker: kalshiTicker ? kalshiEventTickerFromMarketTicker(kalshiTicker) : null,
          allKalshiMarkets,
          kalshiTitle: kalshiResult.initial?.raw?.title || kalshiTicker,
          polyTitle: polyResult.question || polySlug,
          polyTitleAlt: polyResultAlt?.question || polySlugAlt,
          polyOutcomes: polyResult.outcomes || ['Up', 'Down'],
          polyOutcomesAlt: polyResultAlt?.outcomes || ['Up', 'Down'],
          mode: bothPolyInput ? 'poly_poly' : 'kalshi_poly',
        },
        pairing,
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
      try {
        const { computeAndStoreSessionVenuePnl } = await import('./sessionVenuePnl.mjs');
        computeAndStoreSessionVenuePnl(pool, id).then((r) => {
          console.log('[venue-pnl] session', id.slice(0, 8), r.status);
        }).catch((e) => console.error('[venue-pnl]', e.message?.slice(0, 100)));
      } catch (e) {
        console.error('[venue-pnl] import', e.message);
      }
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

  /** Recompute venue-sourced P&L (Kalshi fills + Polymarket data-api trades) for an ended session. */
  // Per-event P&L from actual platform data
  app.get('/api/arb/event-pnl', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit || '10');

      // Get KS orders
      const or = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders?status=executed&limit=500`);
      const od = await or.json();
      const ks = {};
      for (const o of (od.orders || [])) {
        if (!o.ticker?.includes('BTC') && !o.ticker?.includes('ETH') && !o.ticker?.includes('SOL') && !o.ticker?.includes('XRP')) continue;
        if (!ks[o.ticker]) ks[o.ticker] = { orders: [], cost: 0, fees: 0, payout: 0, shares: 0 };
        const cost = parseFloat(o.maker_fill_cost_dollars || '0') + parseFloat(o.taker_fill_cost_dollars || '0');
        const fee = parseFloat(o.maker_fees_dollars || '0') + parseFloat(o.taker_fees_dollars || '0');
        const sh = parseFloat(o.fill_count_fp || '0');
        ks[o.ticker].orders.push({ side: o.side, shares: sh, cost, fee, price: o.yes_price_dollars || o.no_price_dollars });
        ks[o.ticker].cost += cost;
        ks[o.ticker].fees += fee;
        ks[o.ticker].shares += sh;
      }

      // Get KS settlements
      const sr = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/settlements?limit=500`);
      const sd = await sr.json();
      for (const s of (sd.settlements || [])) {
        if (ks[s.ticker]) ks[s.ticker].payout += parseFloat(s.revenue || '0') / 100;
      }

      // Get KS market results
      for (const ticker of Object.keys(ks)) {
        try {
          const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(ticker)}`);
          if (mr.ok) {
            const md = await mr.json();
            ks[ticker].result = md.market?.result; // 'yes' or 'no'
            ks[ticker].status = md.market?.status;
          }
        } catch {}
      }

      // Get Poly activity
      const ar = await fetch('https://data-api.polymarket.com/activity?user=0x175ba0a98ea74525cc7490975bacbb0a1ac3099e&limit=1000');
      const ad = await ar.json();
      const poly = {};
      for (const a of (ad || [])) {
        const slug = a.slug || '';
        if (!slug.match(/(btc|eth|sol|xrp)-updown-15m-/)) continue;
        if (!poly[slug]) poly[slug] = { trades: [], spent: 0, back: 0 };
        const amt = parseFloat(a.usdcSize || '0');
        if (a.type === 'BUY' || a.side === 'BUY') {
          poly[slug].trades.push({ side: a.outcome, cost: amt, type: 'buy' });
          poly[slug].spent += amt;
        } else {
          poly[slug].trades.push({ side: a.outcome, amount: amt, type: 'redeem' });
          poly[slug].back += amt;
        }
      }

      // Get Poly results
      for (const slug of Object.keys(poly)) {
        try {
          const pr = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
          const pd = await pr.json();
          const m = pd?.[0]?.markets?.[0];
          if (m?.closed) {
            const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
            poly[slug].result = parseFloat(prices?.[0] || '0') > 0.5 ? 'up' : 'down';
          }
        } catch {}
      }

      // Build per-event P&L using the correct method
      const events = [];
      for (const [ticker, d] of Object.entries(ks)) {
        const coin = ticker.includes('BTC') ? 'BTC' : ticker.includes('ETH') ? 'ETH' : ticker.includes('SOL') ? 'SOL' : 'XRP';
        const result = d.result; // 'yes' or 'no'
        // KS P&L: per fill — if side matches result, payout = shares × $1, else $0
        let ksPnl = 0;
        const ksDetail = [];
        for (const o of d.orders) {
          const won = (o.side === result);
          const payout = won ? o.shares : 0;
          const pnl = payout - o.cost - o.fee;
          ksPnl += pnl;
          ksDetail.push({ side: o.side, shares: o.shares, cost: o.cost + o.fee, payout, pnl, won });
        }

        // Find matching Poly slug
        // Convert ticker time to poly timestamp
        const m = ticker.match(/(\d{2})(\w{3})(\d{2})(\d{2})(\d{2})/);
        let polyPnl = 0;
        let polySlug = null;
        let polyDetail = [];
        if (m) {
          // KS ticker: 26MAR302345 = year 26, Mar 30, 23:45 ET
          // Convert ET to UTC: +4h for EDT
          const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
          const yr = 2000 + parseInt(m[1]); // m[1] = year (26)
          const mo = months[m[2]];       // m[2] = month (MAR)
          const dy = parseInt(m[3]);     // m[3] = day (31)
          const hr = parseInt(m[4]);
          const mi = parseInt(m[5]);
          // Create as UTC with +4h offset for EDT
          // KS ticker = event END time, Poly slug = event START time
          // Subtract 15min (900s) to get start time
          const utcDate = new Date(Date.UTC(yr, mo, dy, hr + 4, mi));
          const utcTs = Math.floor(utcDate.getTime() / 1000) - 900;
          const polySlotTs = utcTs - (utcTs % 900);
          const expectedSlug = coin.toLowerCase() + '-updown-15m-' + polySlotTs;

          // Direct match first
          if (poly[expectedSlug]) {
            polySlug = expectedSlug;
          } else {
            // Fuzzy match within 2 slots
            for (const [slug, pd] of Object.entries(poly)) {
              if (!slug.includes(coin.toLowerCase())) continue;
              const polyTs = parseInt(slug.match(/\d+$/)?.[0] || '0');
              if (Math.abs(polyTs - polySlotTs) <= 1800) { // within 2 slots (30 min)
                polySlug = slug;
                break;
              }
            }
          }

          if (polySlug && poly[polySlug]) {
            const pd = poly[polySlug];
            // Simple P&L: total back - total spent
            polyPnl = pd.back - pd.spent;
            for (const t of pd.trades) {
              if (t.type === 'buy') {
                polyDetail.push({ side: t.side, cost: t.cost });
              } else {
                polyDetail.push({ side: 'redeem', amount: t.amount });
              }
            }
          }
        }

        events.push({
          ticker: ticker.slice(-12),
          fullTicker: ticker,
          coin,
          result: result || 'pending',
          status: d.status,
          startTs: m ? Math.floor(new Date(Date.UTC(2000+parseInt(m[1]), months[m[2]], parseInt(m[3]), parseInt(m[4])+4, parseInt(m[5]))).getTime()/1000) - 900 : null,
          ks: { orders: ksDetail, total: ksPnl, cost: d.cost + d.fees, payout: d.payout,
                url: 'https://kalshi.com/markets/' + ticker.replace(/-\d+$/, '').toLowerCase().replace('kx','kx') },
          poly: { slug: polySlug, trades: polyDetail, total: polyPnl,
                  url: polySlug ? 'https://polymarket.com/event/' + polySlug : null },
          combined: ksPnl + polyPnl,
        });
      }

      events.sort((a, b) => b.ticker.localeCompare(a.ticker));
      res.json({ events: events.slice(0, limit) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/arb/session/:id/venue-pnl', async (req, res) => {
    try {
      const { id } = req.params;
      const chk = await pool.query('SELECT ended_at FROM arb_sessions WHERE id = $1', [id]);
      if (!chk.rows[0]) return res.status(404).json({ error: 'session not found' });
      if (!chk.rows[0].ended_at) return res.status(400).json({ error: 'session still running; stop first' });
      const { computeAndStoreSessionVenuePnl } = await import('./sessionVenuePnl.mjs');
      const out = await computeAndStoreSessionVenuePnl(pool, id);
      res.json(out);
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
            depthAt2c: asks
              .filter(l => parseFloat(l.price) <= parseFloat(bestAsk.price) + 0.02)
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
            depthAt2c: asks
              .filter(l => parseFloat(l.price) <= parseFloat(bestAsk.price) + 0.02)
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

  /**
   * @param {object} [opts]
   * @param {'good_till_canceled'|'immediate_or_cancel'|'fill_or_kill'} [opts.timeInForce] — IOC sweeps book now; GTC can rest unfilled
   */
  /** Normalize Kalshi API error JSON for logs and thrown Error messages. */
  function formatKalshiApiError(data) {
    if (data == null) return '';
    if (typeof data === 'string') return data.slice(0, 800);
    const e = data.error;
    if (typeof e === 'string') return e;
    if (e?.message) return String(e.message);
    if (Array.isArray(e)) return JSON.stringify(e).slice(0, 800);
    if (data.message) return String(data.message);
    try {
      return JSON.stringify(data).slice(0, 800);
    } catch {
      return String(data);
    }
  }

  async function placeKalshiOrder(ticker, side, count, priceCents, opts = {}) {
    // side: 'yes' or 'no', priceCents: integer 1-99 (0¢ is rejected by Kalshi API)
    if (priceCents == null || priceCents < 1 || priceCents > 99) {
      const msg = `Kalshi limit invalid: ${priceCents}¢ (need 1–99)`;
      console.error(`[KALSHI_ORDER] ${msg}`, { ticker, side, count });
      throw new Error(msg);
    }
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

    if (opts.timeInForce) body.time_in_force = opts.timeInForce;

    console.log(`[KALSHI_ORDER] POST`, JSON.stringify(body));
    const res = await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    const errDetail = formatKalshiApiError(data);
    if (!res.ok) {
      console.error(`[KALSHI_ORDER] HTTP ${res.status} ${ticker} ${side} ${count}@${priceCents}¢ tif=${opts.timeInForce || 'default'}`, errDetail || text.slice(0, 500));
      throw new Error(`Kalshi ${res.status}: ${errDetail || text.slice(0, 200)}`);
    }
    const ord = data?.order;
    const filled = ord ? parseFloat(ord.fill_count_fp || '0') : 0;
    if (opts.timeInForce && filled === 0 && count > 0) {
      console.warn(
        `[KALSHI_ORDER] ${ticker} ${side} ${opts.timeInForce} — 0 fills (status=${ord?.status} remaining=${ord?.remaining_count_fp})`,
      );
    }
    console.log(`[KALSHI_ORDER] OK ${ticker} filled=${filled}/${count} status=${ord?.status}`);
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
      const { kalshiCache, polyCache, kalshiTicker, polyTokens, polyTokensAlt, negRisk, negRiskAlt, tickSize, fee: FEE } = sess;
      if (!polyTokens?.length) return res.status(400).json({ error: 'No Polymarket tokens resolved for this session' });

      const clob = getClobClient?.();
      if (!clob) return res.status(500).json({ error: 'Polymarket CLOB client not ready' });

      const SHARES = 5;
      const tick = parseFloat(tickSize) || 0.01;

      // Poly+Poly mode: execute both legs on Polymarket.
      if (sess.polyOnlyInput) {
        if (!polyTokensAlt?.length) {
          return res.status(400).json({ error: 'Poly+Poly session missing left-side Polymarket tokens', reason: 'poly_only_missing_left_tokens' });
        }
        const [leftUpBook, leftDownBook, rightUpBook, rightDownBook] = await Promise.all([
          fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(polyTokensAlt[0])}`).then(r => r.json()).catch(() => null),
          fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(polyTokensAlt[1])}`).then(r => r.json()).catch(() => null),
          fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(polyTokens[0])}`).then(r => r.json()).catch(() => null),
          fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(polyTokens[1])}`).then(r => r.json()).catch(() => null),
        ]);
        const bestPx = (book) => {
          if (book?.asks?.length) {
            const asks = [...book.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
            const ap = parseFloat(asks[0]?.price);
            if (Number.isFinite(ap)) return ap;
          }
          if (book?.bids?.length) {
            const bids = [...book.bids].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
            const bp = parseFloat(bids[0]?.price);
            if (Number.isFinite(bp)) return bp;
          }
          return null;
        };
        const bestAskQty = (book) => {
          if (!book?.asks?.length) return null;
          const asks = [...book.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
          const q = parseFloat(asks[0]?.size);
          return Number.isFinite(q) ? q : null;
        };
        const depthAt2c = (book) => {
          if (!book?.asks?.length) return null;
          const asks = [...book.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
          const p0 = parseFloat(asks[0]?.price);
          if (!Number.isFinite(p0)) return null;
          return asks
            .filter((l) => parseFloat(l.price) <= p0 + 0.02)
            .reduce((s, l) => s + parseFloat(l.size), 0);
        };
        const leftUpAsk = bestPx(leftUpBook);
        const leftDownAsk = bestPx(leftDownBook);
        const rightUpAsk = bestPx(rightUpBook) ?? polyCache.up ?? null;
        const rightDownAsk = bestPx(rightDownBook) ?? polyCache.down ?? null;
        if ((sess.polyTfMin === 5 || sess.polyTfAltMin === 5) && !sameLeadingDirection(leftUpAsk, rightUpAsk)) {
          return res.status(400).json({
            error: `5m direction gate blocked: left UP ${(leftUpAsk * 100).toFixed(0)}¢ vs right UP ${(rightUpAsk * 100).toFixed(0)}¢`,
            reason: 'poly_5m_direction_mismatch',
          });
        }

        let leftTokenId;
        let rightTokenId;
        let leftPrice;
        let rightPrice;
        let leftSide;
        let rightSide;
        if (strategy === 'A') {
          leftSide = 'up';
          rightSide = swapPoly ? 'up' : 'down';
          leftTokenId = polyTokensAlt[0];
          rightTokenId = polyTokens[swapPoly ? 0 : 1];
          leftPrice = leftUpAsk;
          rightPrice = swapPoly ? rightUpAsk : rightDownAsk;
        } else {
          leftSide = 'down';
          rightSide = swapPoly ? 'down' : 'up';
          leftTokenId = polyTokensAlt[1];
          rightTokenId = polyTokens[swapPoly ? 1 : 0];
          leftPrice = leftDownAsk;
          rightPrice = swapPoly ? rightDownAsk : rightUpAsk;
        }
        if (leftPrice == null || rightPrice == null) {
          return res.status(400).json({ error: 'Missing Poly ask price(s) for dual-poly execution', reason: 'poly_only_missing_ask' });
        }
        // Validate minimum notional against the actual submitted limits.
        const notionalL = 0.99 * SHARES;
        const notionalR = 0.99 * SHARES;
        if (!marketOrder && (notionalL < 1 || notionalR < 1)) {
          return res.status(400).json({
            error: `Polymarket requires >= $1 notional per leg. left=$${notionalL.toFixed(2)} right=$${notionalR.toFixed(2)} for ${SHARES} shares.`,
            reason: 'poly_min_notional_dual',
          });
        }
        const leftLimit = 0.99;
        const rightLimit = 0.99;
        const mkPolyOrder = async (tokenID, price, neg) => {
          const signed = await clob.createOrder({ tokenID, price, size: SHARES, side: 'BUY' }, { tickSize, negRisk: !!neg });
          return clob.postOrder(signed, 'GTC');
        };
        const [leftOutcome, rightOutcome] = await Promise.all([
          mkPolyOrder(leftTokenId, leftLimit, negRiskAlt).then((data) => ({ ok: true, data })).catch((e) => ({ ok: false, error: e.message })),
          mkPolyOrder(rightTokenId, rightLimit, negRisk).then((data) => ({ ok: true, data })).catch((e) => ({ ok: false, error: e.message })),
        ]);
        if (!leftOutcome.ok && !rightOutcome.ok) {
          return res.status(400).json({ error: `Both Poly legs failed: left=${leftOutcome.error}; right=${rightOutcome.error}`, reason: 'poly_poly_both_failed' });
        }
        const leftData = leftOutcome.ok ? leftOutcome.data : null;
        const rightData = rightOutcome.ok ? rightOutcome.data : null;
        const leftStatus = leftData?.status || 'failed';
        const rightStatus = rightData?.status || 'failed';
        const leftTaking = parseFloat(leftData?.takingAmount || '0');
        const rightTaking = parseFloat(rightData?.takingAmount || '0');
        const leftMaking = parseFloat(leftData?.makingAmount || '0');
        const rightMaking = parseFloat(rightData?.makingAmount || '0');
        const leftFilled = leftStatus === 'matched' && leftTaking > 0;
        const rightFilled = rightStatus === 'matched' && rightTaking > 0;
        const leftAvg = leftTaking > 0 ? leftMaking / leftTaking : leftLimit;
        const rightAvg = rightTaking > 0 ? rightMaking / rightTaking : rightLimit;
        const totalCost = (leftMaking || 0) + (rightMaking || 0);
        const expectedPayout = Math.min(leftTaking || 0, rightTaking || 0);
        const expectedProfit = expectedPayout - totalCost;
        const sigPolyUpAskQty = bestAskQty(rightUpBook);
        const sigPolyDownAskQty = bestAskQty(rightDownBook);
        const sigPolyUpDepth2c = depthAt2c(rightUpBook);
        const sigPolyDownDepth2c = depthAt2c(rightDownBook);
        pool.query(
          `INSERT INTO arb_trades (session_id, strategy, kalshi_ticker, kalshi_side, kalshi_limit_cents, kalshi_filled, kalshi_fill_price, kalshi_shares, kalshi_order_id, kalshi_error, poly_token_id, poly_side, poly_limit_price, poly_filled, poly_fill_price, poly_shares, poly_order_id, poly_error, both_filled, total_cost, expected_payout, expected_profit, signal_ks_yes_ask_qty, signal_ks_no_ask_qty, signal_poly_up_ask_qty, signal_poly_down_ask_qty, signal_poly_up_depth_2c, signal_poly_down_depth_2c)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
          [
            sessionId, strategy, `POLY:${sess.polySlugAlt || 'left'}`, leftSide === 'up' ? 'yes' : 'no', Math.round(leftLimit * 100),
            leftFilled, leftAvg, Math.round(leftTaking || 0), leftData?.orderID || leftData?.id || null,
            leftFilled ? null : (leftOutcome.ok ? `poly_left_${leftStatus}` : leftOutcome.error),
            rightTokenId, rightSide, rightLimit,
            rightFilled, rightAvg, Math.round(rightTaking || 0), rightData?.orderID || rightData?.id || null,
            rightFilled ? null : (rightOutcome.ok ? `poly_right_${rightStatus}` : rightOutcome.error),
            leftFilled && rightFilled, totalCost, expectedPayout, expectedProfit,
            null, null, sigPolyUpAskQty, sigPolyDownAskQty, sigPolyUpDepth2c, sigPolyDownDepth2c,
          ],
        ).catch(e => console.error('[arb-execute] DB log error (poly+poly):', e.message));
        return res.json({
          mode: 'poly_poly',
          success: leftFilled && rightFilled,
          kalshi: {
            venue: 'polymarket',
            ok: leftOutcome.ok,
            filled: leftFilled,
            side: leftSide,
            limitPrice: leftLimit,
            avgFillPrice: leftAvg,
            shares: SHARES,
            fillCount: leftTaking || 0,
            status: leftStatus,
            orderId: leftData?.orderID || leftData?.id || null,
            error: leftOutcome.ok ? null : leftOutcome.error,
          },
          poly: {
            venue: 'polymarket',
            ok: rightOutcome.ok,
            filled: rightFilled,
            side: rightSide,
            limitPrice: rightLimit,
            avgFillPrice: rightAvg,
            shares: SHARES,
            fillCount: rightTaking || 0,
            status: rightStatus,
            orderId: rightData?.orderID || rightData?.id || null,
            error: rightOutcome.ok ? null : rightOutcome.error,
          },
        });
      }

      if (!kalshiTicker) return res.status(400).json({ error: 'No Kalshi ticker resolved for this session' });
      if (!hasKalshiAuth()) return res.status(400).json({ error: 'Kalshi auth not configured — set KALSHI_API_KEY + KALSHI_PRIVATE_KEY_PATH in .env' });

      let kalshiSide, polyTokenId, polyPrice;
      const forcePoly99 = sess.polyTfMin === 5 || sess.polyTfAltMin === 5;

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
        if (ksYesAsk == null) {
          console.error(`[arb-execute] BLOCK no KS YES ask kalshiTicker=${kalshiTicker} (REST/WS cache empty)`);
          return res.status(400).json({ error: 'No Kalshi YES ask price available', kalshiTicker, reason: 'no_kalshi_yes_ask' });
        }
        if (pAsk == null) {
          console.error(`[arb-execute] BLOCK no Poly ask kalshiTicker=${kalshiTicker} strategy=A`);
          return res.status(400).json({ error: 'No Poly ask price available', kalshiTicker, reason: 'no_poly_ask' });
        }

        kalshiSide = 'yes';
        polyTokenId = polyTokens[polyDownIdx];
        polyPrice = (marketOrder || forcePoly99) ? 0.99 : pAsk;
      } else {
        // Buy Kalshi NO + Poly opposite side
        const ksNoAsk = ksMarketAsk.no ?? (kalshiCache.noAsk != null ? Math.round(kalshiCache.noAsk * 100) : null);
        const pAsk = swapPoly ? (polyBookAsks.down ?? polyCache.down) : (polyBookAsks.up ?? polyCache.up);
        if (marketOrder) {
          // Skip price checks for market orders
        } else {
          if (ksNoAsk == null) {
            console.error(`[arb-execute] BLOCK no KS NO ask kalshiTicker=${kalshiTicker}`);
            return res.status(400).json({ error: 'No Kalshi NO ask price available', kalshiTicker, reason: 'no_kalshi_no_ask' });
          }
          if (pAsk == null) {
            console.error(`[arb-execute] BLOCK no Poly ask kalshiTicker=${kalshiTicker} strategy=B`);
            return res.status(400).json({ error: 'No Poly ask price available', kalshiTicker, reason: 'no_poly_ask' });
          }
        }

        kalshiSide = 'no';
        polyTokenId = polyTokens[polyUpIdx];
        polyPrice = (marketOrder || forcePoly99) ? 0.99 : (pAsk || 0.50);
      }

      // Pre-check: verify Kalshi market is open for trading
      try {
        const checkR = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(kalshiTicker)}`);
        if (checkR.ok) {
          const checkD = await checkR.json();
          const mktStatus = checkD.market?.status;
          if (mktStatus && mktStatus !== 'active' && mktStatus !== 'open') {
            console.error(`[arb-execute] BLOCK kalshiTicker=${kalshiTicker} status=${mktStatus}`);
            return res.status(400).json({ error: `Kalshi market is ${mktStatus} — trading suspended`, kalshiTicker, reason: 'kalshi_market_status' });
          }
          // Check if can_close_early or similar flags indicate trading is locked
          if (checkD.market?.close_time) {
            const closeTime = new Date(checkD.market.close_time).getTime();
            if (closeTime < Date.now()) {
              console.error(`[arb-execute] BLOCK kalshiTicker=${kalshiTicker} close_time passed`);
              return res.status(400).json({ error: 'Kalshi market trading window has closed', kalshiTicker, reason: 'kalshi_closed' });
            }
          }
        }
      } catch {}

      // Kalshi: IOC at 99¢ cap — not ask-linked; sweeps the book up to 99¢
      const kalshiTakerCents = 99;
      const polyNotional = Number(polyPrice || 0) * SHARES;
      if (!marketOrder && polyNotional < 1) {
        const minShares = Math.ceil(1 / Math.max(0.0001, Number(polyPrice || 0)));
        console.error(
          `[arb-execute] BLOCK poly minimum notional: price=${(Number(polyPrice || 0) * 100).toFixed(1)}¢ shares=${SHARES} notional=$${polyNotional.toFixed(2)} < $1`,
        );
        return res.status(400).json({
          error: `Polymarket requires at least $1 notional for marketable BUY. Current price ${(Number(polyPrice || 0) * 100).toFixed(1)}¢ with ${SHARES} shares is only $${polyNotional.toFixed(2)}.`,
          reason: 'poly_min_notional',
          polyPrice,
          shares: SHARES,
          minSharesNeeded: minShares,
        });
      }

      const combinedCost = kalshiTakerCents + Math.round(polyPrice * 100);
      console.log(`[arb-execute] Manual: KS ${kalshiSide} ≤${kalshiTakerCents}¢ IOC + Poly ${Math.round(polyPrice * 100)}¢ = ${combinedCost}¢`);

      // SAFETY CHECK: verify book depth — need 5+ shares at the ask within profitable range
      const sess2 = sessions.get(sessionId);
      if (sess2?.bookCache?.data && !marketOrder) {
        const bk = sess2.bookCache.data;
        const ksAskQty = kalshiSide === 'yes' ? bk.kalshi?.yesAskQty : bk.kalshi?.noAskQty;
        const polyAskQty = strategy === 'A'
          ? (swapPoly ? (bk.poly?.up?.depthAt2c ?? bk.poly?.up?.depthAt1c ?? bk.poly?.up?.bestAskQty) : (bk.poly?.down?.depthAt2c ?? bk.poly?.down?.depthAt1c ?? bk.poly?.down?.bestAskQty))
          : (swapPoly ? (bk.poly?.down?.depthAt2c ?? bk.poly?.down?.depthAt1c ?? bk.poly?.down?.bestAskQty) : (bk.poly?.up?.depthAt2c ?? bk.poly?.up?.depthAt1c ?? bk.poly?.up?.bestAskQty));

        const MIN_DEPTH = 20; // require 20 shares depth (next 2¢ for Poly)
        if (ksAskQty != null && ksAskQty < MIN_DEPTH) {
          console.error(`[arb-execute] BLOCK depth kalshiTicker=${kalshiTicker} side=${kalshiSide} ksAskQty=${ksAskQty} need=${MIN_DEPTH}`);
          return res.status(400).json({
            error: `Kalshi ${kalshiSide} book too thin: ${ksAskQty} avail, need ${MIN_DEPTH}`,
            kalshiTicker,
            reason: 'kalshi_depth',
          });
        }
        if (polyAskQty != null && polyAskQty < MIN_DEPTH) {
          console.error(`[arb-execute] BLOCK depth poly kalshiTicker=${kalshiTicker} polyAskQty=${polyAskQty} need=${MIN_DEPTH}`);
          return res.status(400).json({
            error: `Poly book too thin: ${polyAskQty} avail, need ${MIN_DEPTH}`,
            kalshiTicker,
            reason: 'poly_depth',
          });
        }
      }
      const sigKsYesAskQty = sess2?.bookCache?.data?.kalshi?.yesAskQty ?? null;
      const sigKsNoAskQty = sess2?.bookCache?.data?.kalshi?.noAskQty ?? null;
      const sigPolyUpAskQty = sess2?.bookCache?.data?.poly?.up?.bestAskQty ?? null;
      const sigPolyDownAskQty = sess2?.bookCache?.data?.poly?.down?.bestAskQty ?? null;
      const sigPolyUpDepth2c = sess2?.bookCache?.data?.poly?.up?.depthAt2c ?? sess2?.bookCache?.data?.poly?.up?.depthAt1c ?? null;
      const sigPolyDownDepth2c = sess2?.bookCache?.data?.poly?.down?.depthAt2c ?? sess2?.bookCache?.data?.poly?.down?.depthAt1c ?? null;

      console.log(`[arb-execute] Strategy ${strategy}: parallel Kalshi ${kalshiSide.toUpperCase()} ${SHARES}@${kalshiTakerCents}¢ IOC + Poly ${Math.round(polyPrice * 100)}¢ = ${kalshiTakerCents + Math.round(polyPrice * 100)}¢`);

      const kalshiPromise = placeKalshiOrder(kalshiTicker, kalshiSide, SHARES, kalshiTakerCents, {
        timeInForce: 'immediate_or_cancel',
      }).then((data) => ({ ok: true, data })).catch((e) => ({ ok: false, error: e.message }));

      const polyPromise = (async () => {
        console.log(`[arb-execute] Poly order: tokenID=${polyTokenId?.slice(0,12)}... price=${polyPrice} size=${SHARES} tickSize=${tickSize} negRisk=${negRisk}`);
        const signed = await clob.createOrder({
          tokenID: polyTokenId,
          price: polyPrice,
          size: SHARES,
          side: 'BUY',
        }, { tickSize, negRisk });
        return clob.postOrder(signed, 'GTC');
      })().then((data) => ({ ok: true, data })).catch((e) => ({ ok: false, error: e.message }));

      const [ksOutcome, polyOutcome] = await Promise.all([kalshiPromise, polyPromise]);

      let kalshiData = ksOutcome.ok ? ksOutcome.data : null;
      let polyResult = polyOutcome.ok ? polyOutcome.data : null;

      if (!ksOutcome.ok) console.error('[arb-execute] Kalshi error:', ksOutcome.error);
      else console.log(`[arb-execute] Kalshi result:`, JSON.stringify(kalshiData).slice(0, 300));

      if (!polyOutcome.ok) console.error('[arb-execute] Poly error:', polyOutcome.error);
      else console.log(`[arb-execute] Poly result:`, JSON.stringify(polyResult).slice(0, 300));

      if (!ksOutcome.ok && !polyOutcome.ok) {
        return res.status(400).json({
          error: `Both legs failed: Kalshi: ${ksOutcome.error}; Poly: ${polyOutcome.error}`,
          kalshiTicker,
          kalshiSide,
        });
      }
      if (!ksOutcome.ok) {
        return res.status(400).json({
          error: `Kalshi failed: ${ksOutcome.error}`,
          kalshiTicker,
          kalshiSide,
          polyOrderId: polyResult?.orderID || polyResult?.id,
          polyStatus: polyResult?.status,
        });
      }
      if (!polyOutcome.ok) {
        return res.status(500).json({
          error: `Polymarket failed: ${polyOutcome.error}`,
          kalshiOrderId: kalshiData?.order?.order_id,
        });
      }

      const kalshiOk = true;
      const polyOk = true;

      console.log(`[arb-execute] Kalshi: OK ${JSON.stringify(kalshiData).slice(0, 200)}`);
      console.log(`[arb-execute] Poly: OK ${JSON.stringify(polyResult).slice(0, 200)}`);

      // Extract Kalshi order details
      const kalshiOrder = kalshiData?.order;
      const kalshiOrderId = kalshiOrder?.order_id || null;
      const kalshiFillCount = kalshiOrder ? parseFloat(kalshiOrder.fill_count_fp || '0') : 0;
      const kalshiFilled = kalshiFillCount > 0;
      // Actual fill price: taker_fill_cost / fill_count gives average fill price
      const kalshiTakerCost = kalshiOrder ? parseFloat(kalshiOrder.taker_fill_cost_dollars || '0') : 0;
      const kalshiMakerCost = kalshiOrder ? parseFloat(kalshiOrder.maker_fill_cost_dollars || '0') : 0;
      const kalshiFillCost = kalshiTakerCost + kalshiMakerCost;
      const kalshiAvgFillPrice = kalshiFillCount > 0 ? Math.round((kalshiFillCost / kalshiFillCount) * 100) : kalshiTakerCents;
      const kalshiStatus = kalshiOrder?.status || 'unknown';
      const kalshiRemaining = kalshiOrder ? parseFloat(kalshiOrder.remaining_count_fp || '0') : 0;

      // Extract Poly order details
      const polyOrderId = polyOk ? (polyResult?.orderID || polyResult?.id || null) : null;
      const polyStatus = polyOk ? (polyResult?.status || 'sent') : 'failed';
      const polyMatched = polyStatus === 'matched'; // Only "matched" means actually filled
      const polyMakingAmt = polyOk ? parseFloat(polyResult?.makingAmount || '0') : 0;
      const polyTakingAmt = polyOk ? parseFloat(polyResult?.takingAmount || '0') : 0;
      const polyFilled = polyMatched && polyTakingAmt > 0;

      if (polyOk && !polyFilled) {
        console.log(`[arb-execute] WARNING: Poly order ${polyStatus} but NOT matched (takingAmt=${polyTakingAmt}). Order is resting, not filled!`);
      }

      // Log to database with REAL fill prices
      const polySide = strategy === 'A' ? 'down' : 'up';
      const kalshiRealPrice = kalshiFillCount > 0 ? kalshiFillCost / kalshiFillCount : kalshiTakerCents / 100;
      const polyActualCost = polyTakingAmt > 0 && polyMakingAmt > 0 ? polyMakingAmt / polyTakingAmt : polyPrice;
      const ksSharesFilled = Math.round(kalshiFillCount);
      const polySharesFilled = polyTakingAmt > 0 ? polyTakingAmt : 0;
      const realTotalCost = kalshiFillCost + (polyMakingAmt || 0);
      const hedgedShares = Math.min(kalshiFillCount, polySharesFilled || 0);
      const expectedPayout = hedgedShares;
      const kalshiFees = parseFloat(kalshiOrder?.taker_fees_dollars || '0') + parseFloat(kalshiOrder?.maker_fees_dollars || '0');
      const realProfit = expectedPayout - kalshiFees - realTotalCost;

      console.log(`[arb-execute] FILL PRICES: Kalshi ${(kalshiRealPrice*100).toFixed(1)}¢ (IOC ${kalshiTakerCents}¢) | Poly ${(polyActualCost*100).toFixed(1)}¢ (limit ${(polyPrice*100).toFixed(0)}¢) | Total cost: $${realTotalCost.toFixed(2)} | Fees: $${kalshiFees.toFixed(2)} | Profit: $${realProfit.toFixed(2)}`);

      pool.query(
        `INSERT INTO arb_trades (session_id, strategy, kalshi_ticker, kalshi_side, kalshi_limit_cents, kalshi_filled, kalshi_fill_price, kalshi_shares, kalshi_order_id, kalshi_error, poly_token_id, poly_side, poly_limit_price, poly_filled, poly_fill_price, poly_shares, poly_order_id, poly_error, both_filled, total_cost, expected_payout, expected_profit, signal_ks_yes_ask_qty, signal_ks_no_ask_qty, signal_poly_up_ask_qty, signal_poly_down_ask_qty, signal_poly_up_depth_2c, signal_poly_down_depth_2c)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
        [
          sessionId, strategy, kalshiTicker, kalshiSide, kalshiTakerCents,
          kalshiOk && kalshiFilled, kalshiRealPrice, ksSharesFilled, kalshiOrderId,
          null,
          polyTokenId, polySide, polyPrice,
          polyFilled, polyActualCost, Math.round(polySharesFilled), polyOrderId,
          polyFilled ? null : (polyOk ? `poly_${polyStatus}` : null),
          kalshiFilled && polyFilled, realTotalCost, expectedPayout, realProfit,
          sigKsYesAskQty, sigKsNoAskQty, sigPolyUpAskQty, sigPolyDownAskQty, sigPolyUpDepth2c, sigPolyDownDepth2c,
        ],
      ).catch(e => console.error('[arb-execute] DB log error:', e.message));

      const response = {
        success: kalshiFilled && polyFilled,
        kalshi: {
          ok: kalshiOk,
          filled: kalshiFilled,
          side: kalshiSide,
          limitPrice: kalshiTakerCents,
          timeInForce: 'immediate_or_cancel',
          avgFillPrice: kalshiAvgFillPrice,
          shares: SHARES,
          fillCount: kalshiFillCount,
          remaining: kalshiRemaining,
          status: kalshiStatus,
          orderId: kalshiOrderId,
          error: null,
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
          error: null,
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
            const eventTicker = kalshiEventTickerFromMarketTicker(match.kalshiTicker);
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
      const { kalshiUrl, polyUrl, label, autoEnabled, autoThreshold, autoCooldown, swapPoly, recurring, earlyExit, exitThreshold, maxShares } = req.body || {};
      if (!kalshiUrl || !polyUrl) return res.status(400).json({ error: 'kalshiUrl and polyUrl required' });
      const maxSharesSafe = Math.max(1, Math.min(1000, parseInt(maxShares, 10) || GLOBAL_MAX_SHARES));
      const bothPolyInput = looksPolymarketUrl(String(kalshiUrl)) && looksPolymarketUrl(String(polyUrl));

      const recurringType = recurring ? detectRecurringType(kalshiUrl, polyUrl) : null;
      let sessionId;
      let kalshiUrlSaved = kalshiUrl;
      let polyUrlSaved = polyUrl;

      if (recurringType) {
        // For recurring, start with current slot
        const slotResult = await startSlotSession(recurringType);
        if (!slotResult) return res.status(500).json({ error: 'Could not start slot session' });
        sessionId = slotResult.sessionId;
        kalshiUrlSaved = slotResult.kalshiUrl || kalshiUrl;
        polyUrlSaved = slotResult.polyUrl || polyUrl;
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

      // Prevent duplicate recurring campaigns for same type
      if (recurring && recurringType) {
        const dup = await pool.query("SELECT id FROM arb_campaigns WHERE recurring_type = $1 AND status = 'running'", [recurringType]);
        if (dup.rows.length > 0) {
          return res.status(400).json({ error: `A ${recurringType} campaign is already running (${dup.rows[0].id.slice(0,8)})` });
        }
      }

      // Save campaign to DB
      const ins = await pool.query(
        `INSERT INTO arb_campaigns (label, kalshi_url, poly_url, kalshi_ticker, auto_enabled, auto_threshold_cents, auto_cooldown_sec, swap_poly, session_id, status, recurring, recurring_type, early_exit, exit_threshold_cents, max_shares)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10,$11,$12,$13,$14) RETURNING *`,
        [label || null, kalshiUrlSaved, polyUrlSaved, null, autoEnabled || false, autoThreshold || 3, autoCooldown || 60, swapPoly || false, sessionId, recurring || false, recurringType, earlyExit || false, exitThreshold || 4, maxSharesSafe],
      );
      const campaign = ins.rows[0];

      // Start server-side auto-buy if enabled
      console.log(`[arb-campaign] Created: auto=${autoEnabled} threshold=${autoThreshold} cooldown=${autoCooldown} recurring=${recurring} swap=${swapPoly} maxShares=${maxSharesSafe}`);
      if (autoEnabled) {
        const bothPolyForAuto = recurringType ? false : bothPolyInput;
        startCampaignAuto(campaign.id, sessionId, autoThreshold || 3, autoCooldown || 60, swapPoly || false, recurring || false, recurringType, earlyExit || false, exitThreshold || 4, maxSharesSafe, bothPolyForAuto);
      }

      res.json({ campaign, sessionId });
    } catch (e) {
      console.error('[arb-campaign] create error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /** Detect recurring event type from URLs */
  function detectRecurringType(kalshiUrl, polyUrl) {
    const k = String(kalshiUrl || '').toUpperCase();
    const p = String(polyUrl || '').toLowerCase();
    const kPoly = String(kalshiUrl || '').toLowerCase();
    const km = k.match(/KX([A-Z]+)(\d+)M/i);
    const pm = p.match(/(btc|eth|sol|hype|xrp|bnb|doge)-updown-(\d+)m-/i);
    const kmPoly = kPoly.match(/(btc|eth|sol|hype|xrp|bnb|doge)-updown-(\d+)m-/i);
    const kAsset = km?.[1]?.toLowerCase() || null;
    const kTf = km?.[2] ? parseInt(km[2], 10) : null;
    const pAsset = pm?.[1]?.toLowerCase() || null;
    const pTf = pm?.[2] ? parseInt(pm[2], 10) : null;
    const kPolyAsset = kmPoly?.[1]?.toLowerCase() || null;
    const kPolyTf = kmPoly?.[2] ? parseInt(kmPoly[2], 10) : null;

    // Mixed recurring modes requested: Kalshi BTC 15m with Poly BTC/ETH 5m.
    if (kAsset === 'btc' && kTf === 15 && pAsset === 'btc' && pTf === 5) return 'btc15m_polybtc5m';
    if (kAsset === 'btc' && kTf === 15 && pAsset === 'eth' && pTf === 5) return 'btc15m_polyeth5m';
    // Accept Poly URL in "Kalshi" field too for these mixed modes.
    if (!kAsset && kPolyAsset === 'btc' && kPolyTf === 5 && pAsset === 'btc' && pTf === 5) return 'btc15m_polybtc5m';
    if (!kAsset && kPolyAsset === 'btc' && kPolyTf === 5 && pAsset === 'eth' && pTf === 5) return 'btc15m_polyeth5m';
    if (!kAsset && kPolyAsset === 'eth' && kPolyTf === 5 && pAsset === 'btc' && pTf === 5) return 'btc15m_polyeth5m';
    if (!kAsset && kPolyAsset === 'eth' && kPolyTf === 5 && pAsset === 'eth' && pTf === 5) return 'btc15m_polyeth5m';
    // If both fields are Poly 5m and ambiguous, prefer Kalshi-field Poly asset.
    if (!kAsset && kPolyTf === 5 && pTf === 5) {
      if (kPolyAsset === 'eth') return 'btc15m_polyeth5m';
      if (kPolyAsset === 'btc') return 'btc15m_polybtc5m';
    }

    // Standard same-asset 15m recurring modes.
    if ((kAsset === 'btc' && kTf === 15) || (pAsset === 'btc' && pTf === 15)) return 'btc15m';
    if ((kAsset === 'eth' && kTf === 15) || (pAsset === 'eth' && pTf === 15)) return 'eth15m';
    if ((kAsset === 'sol' && kTf === 15) || (pAsset === 'sol' && pTf === 15)) return 'sol15m';
    if ((kAsset === 'hype' && kTf === 15) || (pAsset === 'hype' && pTf === 15)) return 'hype15m';
    if ((kAsset === 'xrp' && kTf === 15) || (pAsset === 'xrp' && pTf === 15)) return 'xrp15m';
    if ((kAsset === 'bnb' && kTf === 15) || (pAsset === 'bnb' && pTf === 15)) return 'bnb15m';
    if ((kAsset === 'doge' && kTf === 15) || (pAsset === 'doge' && pTf === 15)) return 'doge15m';
    return null;
  }

  /** Compute current slot URLs for a recurring type */
  function getCurrentSlotUrls(recurringType) {
    const now = Math.floor(Date.now() / 1000);
    const map = {
      btc15m: { series: 'KXBTC15M', polyAsset: 'btc', polyTf: 15, kalshiTf: 15 },
      eth15m: { series: 'KXETH15M', polyAsset: 'eth', polyTf: 15, kalshiTf: 15 },
      sol15m: { series: 'KXSOL15M', polyAsset: 'sol', polyTf: 15, kalshiTf: 15 },
      hype15m: { series: 'KXHYPE15M', polyAsset: 'hype', polyTf: 15, kalshiTf: 15 },
      xrp15m: { series: 'KXXRP15M', polyAsset: 'xrp', polyTf: 15, kalshiTf: 15 },
      bnb15m: { series: 'KXBNB15M', polyAsset: 'bnb', polyTf: 15, kalshiTf: 15 },
      doge15m: { series: 'KXDOGE15M', polyAsset: 'doge', polyTf: 15, kalshiTf: 15 },
      btc15m_polybtc5m: { series: 'KXBTC15M', polyAsset: 'btc', polyTf: 5, kalshiTf: 15 },
      btc15m_polyeth5m: { series: 'KXBTC15M', polyAsset: 'eth', polyTf: 5, kalshiTf: 15 },
    };
    const m = map[recurringType];
    if (!m) return null;
    const polySlotSec = m.polyTf * 60;
    const slot = Math.floor(now / polySlotSec) * polySlotSec;
    return {
      polyUrl: `https://polymarket.com/event/${m.polyAsset}-updown-${m.polyTf}m-${slot}`,
      kalshiSeries: m.series,
      polyTfSec: m.polyTf * 60,
      kalshiTfSec: m.kalshiTf * 60,
      slot,
    };
  }

  /** Start a new session for the current slot, return sessionId */
  async function startSlotSession(recurringType) {
    const urls = getCurrentSlotUrls(recurringType);
    if (!urls) return null;
    const expectedSlotTag = polyUnixToKalshiSlotTag(urls.slot + (urls.polyTfSec || 900));
    const enforceSlotMatch = (urls.polyTfSec || 900) === (urls.kalshiTfSec || 900);

    // Find current Kalshi event
    try {
      const er = await kalshiFetch(`${KALSHI_TRADE_API}/events?series_ticker=${urls.kalshiSeries}&limit=25&status=open`);
      const ed = await er.json();
      const events = ed.events || [];
      const ev = events.find((e) => String(e?.event_ticker || '').toUpperCase().includes(expectedSlotTag))
        || events[0];
      if (!ev) { console.log(`[recurring] No open ${urls.kalshiSeries} event`); return null; }

      // Get market ticker — only active markets
      const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets?event_ticker=${ev.event_ticker}&limit=5`);
      const md = await mr.json();
      const mkts = md.markets || [];
      const mkt = enforceSlotMatch
        ? (
            mkts.find((m) => m.status === 'active' && extractKalshiCryptoSlotTag(m.ticker) === expectedSlotTag)
            || mkts.find((m) => extractKalshiCryptoSlotTag(m.ticker) === expectedSlotTag)
            || mkts.find((m) => m.status === 'active')
            || mkts[0]
          )
        : (mkts.find((m) => m.status === 'active') || mkts[0]);
      if (!mkt || mkt.status === 'settled' || mkt.status === 'closed') {
        console.log(`[recurring] ${urls.kalshiSeries} market ${mkt?.ticker} is ${mkt?.status} — skipping`);
        return null;
      }
      const kalshiUrl = mkt.ticker || ev.event_ticker;
      if (enforceSlotMatch && extractKalshiCryptoSlotTag(kalshiUrl) !== expectedSlotTag) {
        console.log(`[recurring] Slot mismatch; expected=${expectedSlotTag} got=${kalshiUrl} — skipping`);
        return null;
      }

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

  function startCampaignAuto(campaignId, sessionId, thresholdCents, cooldownSec, swapPoly, recurring, recurringType, earlyExit = false, exitThresholdCents = 4, maxShares = GLOBAL_MAX_SHARES, polyOnlyInput = false) {
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

    // Honor UI cooldown (minimum 1s safety floor)
    cooldownSec = Math.max(1, parseInt(cooldownSec, 10) || 1);
    maxShares = Math.max(1, Math.min(1000, parseInt(maxShares, 10) || GLOBAL_MAX_SHARES));

    const state = {
      currentSessionId: sessionId, currentSlot: 0, renewLock: false,
      swapPoly: !!swapPoly, // live flag: PATCH updates apply on next tick/trade
      maxShares,
      nextStrategy: null, // enforce A -> B -> A alternation after filled trades
      polyOnlyInput: !!polyOnlyInput,
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
                body: JSON.stringify({ sessionId: state.currentSessionId, strategy: 'A', swapPoly: !!state.swapPoly, marketOrder: true, sell: true }),
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
                body: JSON.stringify({ sessionId: state.currentSessionId, strategy: 'B', swapPoly: !!state.swapPoly, marketOrder: true, sell: true }),
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

      // ── TAKER STRATEGY ──
      const sess = sessions.get(state.currentSessionId);
      if (!sess?.bookCache?.data) return;
      if (sess.polyOnlyInput) {
        const bookPP = sess.bookCache.data;
        const left = bookPP.polyA;
        const right = bookPP.polyB || bookPP.poly;
        const feePP = 0.02;
        const leftUpAsk = left?.up?.bestAsk ?? left?.up?.bestBid ?? null;
        const leftDownAsk = left?.down?.bestAsk ?? left?.down?.bestBid ?? null;
        const rightUpAsk = right?.up?.bestAsk ?? right?.up?.bestBid ?? null;
        const rightDownAsk = right?.down?.bestAsk ?? right?.down?.bestBid ?? null;
        if (leftUpAsk == null || leftDownAsk == null || rightUpAsk == null || rightDownAsk == null) {
          if (!state.polyOnlyWarnTs || Date.now() - state.polyOnlyWarnTs > 30000) {
            state.polyOnlyWarnTs = Date.now();
            console.log(`[auto-campaign:${campaignId.slice(0,8)}] Poly+Poly waiting for both books`);
          }
          return;
        }
        if ((sess.polyTfMin === 5 || sess.polyTfAltMin === 5) && !sameLeadingDirection(leftUpAsk, rightUpAsk)) {
          if (!state.polyDirWarnTs || Date.now() - state.polyDirWarnTs > 15000) {
            state.polyDirWarnTs = Date.now();
            console.log(
              `[auto-campaign:${campaignId.slice(0,8)}] 5m direction gate skip: leftUP=${(leftUpAsk * 100).toFixed(0)}¢ rightUP=${(rightUpAsk * 100).toFixed(0)}¢`,
            );
          }
          return;
        }
        const costA = leftUpAsk + (state.swapPoly ? rightUpAsk : rightDownAsk);
        const costB = leftDownAsk + (state.swapPoly ? rightDownAsk : rightUpAsk);
        const profitA = 1 - feePP - costA;
        const profitB = 1 - feePP - costB;
        const threshold = thresholdCents / 100;
        const aOk = profitA >= threshold && costA <= 0.97;
        const bOk = profitB >= threshold && costB <= 0.97;
        let bestStrategy = null;
        if (state.swapPoly && (state.nextStrategy === 'A' || state.nextStrategy === 'B')) {
          // Strict alternation: once a leg fills, require the opposite on the next fill.
          if (state.nextStrategy === 'A' && aOk) bestStrategy = 'A';
          else if (state.nextStrategy === 'B' && bOk) bestStrategy = 'B';
          else return;
        } else if (aOk && (!bOk || profitA >= profitB)) bestStrategy = 'A';
        else if (bOk) bestStrategy = 'B';
        if (!bestStrategy) return;

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

        try {
          const caps = await pool.query(
            `SELECT
               COALESCE(SUM(CASE WHEN kalshi_filled THEN kalshi_shares ELSE 0 END), 0) AS left_shares,
               COALESCE(SUM(CASE WHEN poly_filled THEN poly_shares ELSE 0 END), 0) AS right_shares
             FROM arb_trades
             WHERE session_id = $1`,
            [state.currentSessionId],
          );
          const leftShares = parseInt(caps.rows[0]?.left_shares || '0', 10) || 0;
          const rightShares = parseInt(caps.rows[0]?.right_shares || '0', 10) || 0;
          const capLimit = Math.max(1, Math.min(1000, parseInt(state.maxShares, 10) || maxShares));
          if (leftShares >= capLimit || rightShares >= capLimit) return;
        } catch {
          return;
        }

        try {
          const er = await fetch(`http://localhost:${process.env.PORT || 3001}/api/arb/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: state.currentSessionId, strategy: bestStrategy, swapPoly: !!state.swapPoly }),
          });
          if (!er.ok) {
            const ed = await er.json().catch(() => ({}));
            if (!state.lastPolyExecErr || Date.now() - state.lastPolyExecErr > 15000) {
              state.lastPolyExecErr = Date.now();
              console.log(`[auto-campaign:${campaignId.slice(0,8)}] Poly+Poly execute blocked: ${ed.error || er.status}`);
            }
          } else {
            const ed = await er.json().catch(() => ({}));
            if (ed?.success && state.swapPoly) state.nextStrategy = bestStrategy === 'A' ? 'B' : 'A';
          }
        } catch {}
        return;
      }

      const book = sess.bookCache.data;
      const fee = 0.02;
      // halfTarget removed — taker mode uses full threshold
      const polyUpAsk = book.poly?.up?.bestAsk;
      const polyDownAsk = book.poly?.down?.bestAsk;
      const polyUpBid = book.poly?.up?.bestBid;
      const polyDownBid = book.poly?.down?.bestBid;
      const ksYesBid = book.kalshi?.yesBid;
      const ksNoBid = book.kalshi?.noBid;
      const ksYesAsk = book.kalshi?.yesAsk;
      const ksNoAsk = book.kalshi?.noAsk;
      const pDownAsk = state.swapPoly ? polyUpAsk : polyDownAsk;
      const pUpAsk = state.swapPoly ? polyDownAsk : polyUpAsk;
      const pDownBid = state.swapPoly ? polyUpBid : polyDownBid;

      // Spread (dollars per share after 2¢ fee model) — computed once for gates + skip logging
      const costA = ksYesAsk != null && pDownAsk != null ? ksYesAsk + pDownAsk : null;
      const profitA = costA != null ? 1 - fee - costA : null;
      const costB = ksNoAsk != null && pUpAsk != null ? ksNoAsk + pUpAsk : null;
      const profitB = costB != null ? 1 - fee - costB : null;
      const bestProfit = Math.max(profitA ?? -1, profitB ?? -1);
      const threshold = thresholdCents / 100;
      const LOG_EDGE = parseFloat(process.env.ARB_SKIP_LOG_MIN_PROFIT || '0.04') || 0.04;

      if (!state.arbSkipLog) state.arbSkipLog = {};
      const logSkipIfGoodEdge = (reason, extra = '') => {
        if (bestProfit < LOG_EDGE) return;
        const tag = `${reason}:${extra.slice(0, 40)}`;
        const last = state.arbSkipLog[tag] || 0;
        if (Date.now() - last < 5000) return;
        state.arbSkipLog[tag] = Date.now();
        const pa = profitA != null ? `${(profitA * 100).toFixed(1)}¢` : '—';
        const pb = profitB != null ? `${(profitB * 100).toFixed(1)}¢` : '—';
        const ca = costA != null ? `${(costA * 100).toFixed(0)}¢` : '—';
        const cb = costB != null ? `${(costB * 100).toFixed(0)}¢` : '—';
        console.log(
          `[arb-skip:${campaignId.slice(0, 8)}] best=${(bestProfit * 100).toFixed(1)}¢/sh A=${pa} B=${pb} costA=${ca} costB=${cb} thr=${thresholdCents}¢ log≥${(LOG_EDGE * 100).toFixed(1)}¢ | ${reason}${extra ? ' | ' + extra : ''}`,
        );
      };

      // ── No pending orders — taker mode only ──

      // DB COOLDOWN: check last fill time
      try {
        const lastTrade = await pool.query(
          `SELECT ts FROM arb_trades WHERE session_id = $1 ORDER BY ts DESC LIMIT 1`,
          [state.currentSessionId],
        );
        if (lastTrade.rows[0]) {
          const secsSinceLast = (Date.now() - new Date(lastTrade.rows[0].ts).getTime()) / 1000;
          if (secsSinceLast < cooldownSec) {
            logSkipIfGoodEdge('cooldown', `${secsSinceLast.toFixed(0)}s of ${cooldownSec}s`);
            return;
          }
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
        const capLimit = Math.max(1, Math.min(1000, parseInt(state.maxShares, 10) || maxShares));

        if (!state.lastCapLog2 || Date.now() - state.lastCapLog2 > 30000) {
          state.lastCapLog2 = Date.now();
          console.log(`[maker:${campaignId.slice(0,8)}] Positions: KS ${ksShares}/${capLimit} Poly ${polyShares}/${capLimit} (${sess.kalshiTicker})`);
        }

        if (ksShares >= capLimit || polyShares >= capLimit) {
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
          console.log(`[maker:${campaignId.slice(0,8)}] CAP HIT: KS ${ksShares}/${capLimit} Poly ${polyShares}/${capLimit} — pausing until next slot`);
          logSkipIfGoodEdge('position_cap', `KS=${ksShares} Poly=${polyShares} cap=${capLimit}`);
          return;
        }
      } catch (capErr) {
        // Cap check failed — DON'T trade without safety check
        console.error(`[arb:${campaignId.slice(0,8)}] Cap check error — blocking trade:`, capErr.message?.slice(0, 80));
        logSkipIfGoodEdge('cap_check_error', capErr.message?.slice(0, 80) || 'unknown');
        return;
      }

      // STOP-LOSS: if platforms diverge by 20¢+ (one says up, other says down), sell everything
      // If both agree on direction → hedge works → keep
      {
        const ksYesPrice = ksYesBid != null && ksYesAsk != null ? (ksYesBid + ksYesAsk) / 2 : ksYesBid || ksYesAsk;
        const polyUpPrice = pUpAsk != null ? pUpAsk : null; // use swap-adjusted price
        if (ksYesPrice == null || polyUpPrice == null) {
          logSkipIfGoodEdge('divergence_guard', 'missing KS mid or Poly up ask');
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

          // Check if platforms AGREE on direction (both >50% same side or both <50%)
          const sameDirection = (ksYesPrice > 0.50 && polyUpPrice > 0.50) || (ksYesPrice < 0.50 && polyUpPrice < 0.50);

          // Gap recovered — reset hedge flag
          if (divergence < 0.10 && state.hedgedDivergence) {
            state.hedgedDivergence = false;
            console.log(`[arb:${campaignId.slice(0,8)}] Gap recovered to ${(divergence*100).toFixed(0)}¢ — resuming`);
          }

          // 10¢+ gap → only pause if platforms DISAGREE on direction
          if (divergence >= 0.10 && divergence < 0.20 && !sameDirection) {
            if (!state.lastGapLog || Date.now() - state.lastGapLog > 30000) {
              state.lastGapLog = Date.now();
              console.log(`[arb:${campaignId.slice(0,8)}] GAP ${(divergence*100).toFixed(0)}¢ + DISAGREE (KS ${(ksYesPrice*100).toFixed(0)}¢ vs Poly ${(polyUpPrice*100).toFixed(0)}¢) — pausing`);
            }
            logSkipIfGoodEdge('gap_disagree_10_20c', `div=${(divergence * 100).toFixed(0)}¢`);
            return;
          }
          // 10¢+ gap but same direction → trade allowed
          if (divergence >= 0.10 && sameDirection) {
            if (!state.lastGapLog || Date.now() - state.lastGapLog > 30000) {
              state.lastGapLog = Date.now();
              console.log(`[arb:${campaignId.slice(0,8)}] GAP ${(divergence*100).toFixed(0)}¢ but AGREE direction — trading allowed`);
            }
          }

          if (divergence >= 0.20 && !sameDirection) {
            // 20¢+ gap AND platforms DISAGREE — hedge opposite
            if (!state.sessionStartTime) state.sessionStartTime = Date.now();
            if (Date.now() - state.sessionStartTime < 10000) {
              if (!state.lastDivLog || Date.now() - state.lastDivLog > 5000) {
                state.lastDivLog = Date.now();
                console.log(`[stop-loss:${campaignId.slice(0,8)}] DIVERGENCE ${(divergence*100).toFixed(0)}¢ DISAGREE — waiting 10s grace period`);
              }
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
            logSkipIfGoodEdge('hedge_lock_20c', `div=${(divergence * 100).toFixed(0)}¢ DISAGREE`);
            return;
          } else {
            // Already hedged divergence — just wait
            logSkipIfGoodEdge('hedge_lock_wait', 'already hedged, gap still ≥20¢ DISAGREE');
            return;
          }
          } // close else (grace period)
        }
      }

      // Debug log (spread already computed above)
      if (!state.lastDebug || Date.now() - state.lastDebug > 30000) {
        state.lastDebug = Date.now();
        const ksBidQtyDbg = book.kalshi?.yesBidQty;
        const polyBidQtyDbg = state.swapPoly ? book.poly?.up?.bestBidQty : book.poly?.down?.bestBidQty;
        console.log(`[maker:${campaignId.slice(0,8)}] Book: A=${profitA != null ? (profitA*100).toFixed(1)+'¢' : '—'} B=${profitB != null ? (profitB*100).toFixed(1)+'¢' : '—'} | threshold=${thresholdCents}¢ | ksBid=${ksYesBid != null ? (ksYesBid*100).toFixed(0)+'¢' : 'null'}(${ksBidQtyDbg}) pDownBid=${pDownBid != null ? (pDownBid*100).toFixed(0)+'¢' : 'null'}(${polyBidQtyDbg}) | no pending`);
      }

      const aOk = profitA != null && profitA >= threshold && costA <= 0.97;
      const bOk = profitB != null && profitB >= threshold && costB <= 0.97;
      let bestStrategy = null;
      if (state.swapPoly && (state.nextStrategy === 'A' || state.nextStrategy === 'B')) {
        // Strict alternation in auto mode.
        if (state.nextStrategy === 'A' && aOk) bestStrategy = 'A';
        else if (state.nextStrategy === 'B' && bOk) bestStrategy = 'B';
      } else if (aOk && (!bOk || profitA >= profitB)) bestStrategy = 'A';
      else if (bOk) bestStrategy = 'B';

      if (!bestStrategy && bestProfit > 0) {
        pool.query(
          `INSERT INTO arb_signals (campaign_id, kalshi_ticker, strategy, spread, divergence, ks_ask, poly_ask, action, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [campaignId, sess.kalshiTicker, profitA >= profitB ? 'A' : 'B',
           bestProfit, null, ksYesAsk, pDownAsk,
           'skip', 'below_threshold_' + thresholdCents + 'c_profit_' + (bestProfit*100).toFixed(1) + 'c'],
        ).catch(() => {});
      }
      if (!bestStrategy) {
        if (bestProfit >= LOG_EDGE) {
          const aOk = profitA != null && profitA >= threshold && costA <= 0.97;
          const bOk = profitB != null && profitB >= threshold && costB <= 0.97;
          const detail = [
            `A_ok=${aOk} p=${profitA != null ? (profitA * 100).toFixed(1) + '¢' : '—'} c=${costA != null ? (costA * 100).toFixed(0) + '¢' : '—'}`,
            `B_ok=${bOk} p=${profitB != null ? (profitB * 100).toFixed(1) + '¢' : '—'} c=${costB != null ? (costB * 100).toFixed(0) + '¢' : '—'}`,
            `tie=A_if_pA>=pB`,
          ];
          if (aOk && profitB != null && profitA < profitB && !bOk) detail.push('B higher profit but B fails thr/cost≤97¢');
          logSkipIfGoodEdge('no_strategy', detail.join(' '));
        }
        return;
      }

      // Liquidity: require 20 shares available; Poly uses depth across next 2¢.
      // Top-of-book profit is misleading when quoted ask has tiny displayed size.
      const MIN_LIQ = 20;
      const ksYQty = book.kalshi?.yesAskQty;
      const ksNQty = book.kalshi?.noAskQty;
      const polyDn = book.poly?.down;
      const polyUp = book.poly?.up;
      const downLiq = polyDn?.depthAt2c ?? polyDn?.depthAt1c ?? polyDn?.bestAskQty;
      const upLiq = polyUp?.depthAt2c ?? polyUp?.depthAt1c ?? polyUp?.bestAskQty;
      const liqAks = ksYQty;
      const liqApoly = state.swapPoly ? upLiq : downLiq;
      const liqBks = ksNQty;
      const liqBpoly = state.swapPoly ? downLiq : upLiq;
      if (bestStrategy === 'A') {
        if (liqAks != null && liqAks < MIN_LIQ) {
          logSkipIfGoodEdge('liquidity', `strat=A KS_YES_ask_qty=${liqAks}<${MIN_LIQ}`);
          return;
        }
        if (liqApoly != null && liqApoly < MIN_LIQ) {
          logSkipIfGoodEdge('liquidity', `strat=A poly_down_qty=${liqApoly}<${MIN_LIQ} swapPoly=${state.swapPoly}`);
          return;
        }
      } else {
        if (liqBks != null && liqBks < MIN_LIQ) {
          logSkipIfGoodEdge('liquidity', `strat=B KS_NO_ask_qty=${liqBks}<${MIN_LIQ}`);
          return;
        }
        if (liqBpoly != null && liqBpoly < MIN_LIQ) {
          logSkipIfGoodEdge('liquidity', `strat=B poly_up_qty=${liqBpoly}<${MIN_LIQ} swapPoly=${state.swapPoly}`);
          return;
        }
      }

      // Determine sides and prices
      const { polyTokens } = sess;
      const polyDownIdx = state.swapPoly ? 0 : 1;
      const polyUpIdx = state.swapPoly ? 1 : 0;
      let ksSide, ksAskPrice, polyTokenId, polyAsk;

      if (bestStrategy === 'A') {
        ksSide = 'yes';
        ksAskPrice = ksYesAsk != null ? Math.round(ksYesAsk * 100) : null;
        polyTokenId = polyTokens?.[polyDownIdx];
        polyAsk = pDownAsk;
      } else {
        ksSide = 'no';
        ksAskPrice = ksNoAsk != null ? Math.round(ksNoAsk * 100) : null;
        polyTokenId = polyTokens?.[polyUpIdx];
        polyAsk = pUpAsk;
      }

      // REST snapshot: WS book can report tiny asks that round to 0¢ → Kalshi 400 "invalid order"
      try {
        const mr = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(sess.kalshiTicker)}`);
        if (mr.ok) {
          const m = (await mr.json()).market;
          if (m) {
            if (ksSide === 'yes') {
              const ya = parseFloat(m.yes_ask_dollars);
              if (!Number.isNaN(ya) && ya > 0) ksAskPrice = Math.round(ya * 100);
            } else {
              const na = parseFloat(m.no_ask_dollars);
              if (!Number.isNaN(na) && na > 0) ksAskPrice = Math.round(na * 100);
            }
          }
        }
      } catch {}

      if (polyAsk == null) {
        logSkipIfGoodEdge('missing_poly_ask', `strat=${bestStrategy} tokenIdx=${bestStrategy === 'A' ? polyDownIdx : polyUpIdx}`);
        return;
      }
      if (ksAskPrice == null || ksAskPrice < 1 || ksAskPrice > 99) {
        logSkipIfGoodEdge('kalshi_limit_invalid', `${ksSide} ${ksAskPrice == null ? 'null' : ksAskPrice + '¢'} after REST`);
        if (!state.lastKsSkipLog || Date.now() - state.lastKsSkipLog > 15000) {
          state.lastKsSkipLog = Date.now();
          console.log(`[arb:${campaignId.slice(0,8)}] Skip trade: Kalshi ${ksSide} ask unusable (${ksAskPrice == null ? 'null' : ksAskPrice + '¢'}) after REST — not placing`);
        }
        return;
      }

      // Kalshi: IOC @ 99¢ (same as manual /api/arb/execute). Omitting time_in_force defaulted to GTC at ask → orders rested and often did not fill.
      const ksIocCents = 99;

      // ── Find or create event record ──
      const coin = recurringType?.replace('15m', '') || 'btc';
      // KS ticker time = end time, subtract 900 for start
      const ksMatch = sess.kalshiTicker?.match(/(\d{2})(\w{3})(\d{2})(\d{2})(\d{2})/);
      let eventId = null;
      if (ksMatch) {
        const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
        const utcEnd = new Date(Date.UTC(2000+parseInt(ksMatch[1]), months[ksMatch[2]], parseInt(ksMatch[3]), parseInt(ksMatch[4])+4, parseInt(ksMatch[5])));
        const startTs = Math.floor(utcEnd.getTime()/1000) - 900;
        const polySlug = coin + '-updown-15m-' + startTs;
        try {
          const evR = await pool.query(
            `INSERT INTO arb_events (coin, start_ts, kalshi_ticker, poly_slug) VALUES ($1,$2,$3,$4)
             ON CONFLICT (coin, start_ts) DO UPDATE SET kalshi_ticker = $3
             RETURNING id`,
            [coin.toUpperCase(), startTs, sess.kalshiTicker, polySlug]
          );
          eventId = evR.rows[0]?.id;
        } catch {}
      }

      // ── TAKER BOTH: Kalshi + Polymarket in parallel; Poly always 5sh @ 99¢ limit ──
      const entryProfit = bestStrategy === 'A' ? profitA : profitB;
      const SHARES = 5;
      const polyPrice = 0.99;
      console.log(`[arb:${campaignId.slice(0,8)}] PARALLEL: KS ${ksSide.toUpperCase()} ${SHARES}sh IOC ≤${ksIocCents}¢ (mkt ask ${ksAskPrice}¢) + Poly ${SHARES}sh @ 99¢ (mkt ask ${(polyAsk * 100).toFixed(0)}¢) profit:${(entryProfit * 100).toFixed(1)}¢`);

      // Log entry signal
      pool.query(
        `INSERT INTO arb_signals (campaign_id, kalshi_ticker, strategy, spread, ks_ask, poly_ask, action, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [campaignId, sess.kalshiTicker, bestStrategy, entryProfit, ksAskPrice/100, polyAsk, 'enter', 'spread_' + (entryProfit*100).toFixed(1) + 'c'],
      ).catch(() => {});

      try {
        const clob = getClobClient?.();
        if (!clob) {
          logSkipIfGoodEdge('no_clob_client', 'getClobClient() null');
          console.error(`[arb:${campaignId.slice(0,8)}] No CLOB client — skip trade`);
        } else {
          const { negRisk, tickSize } = sess;
          const [kalshiResult, polyResult] = await Promise.allSettled([
            placeKalshiOrder(sess.kalshiTicker, ksSide, SHARES, ksIocCents, {
              timeInForce: 'immediate_or_cancel',
            }),
            (async () => {
              const signed = await clob.createOrder({
                tokenID: polyTokenId,
                price: polyPrice,
                size: SHARES,
                side: 'BUY',
              }, { tickSize: tickSize || '0.01', negRisk: negRisk || false });
              return clob.postOrder(signed, 'GTC');
            })(),
          ]);

          const kalshiOk = kalshiResult.status === 'fulfilled';
          const polyOk = polyResult.status === 'fulfilled';

          if (!kalshiOk) {
            const r = kalshiResult.reason;
            console.error(
              `[arb:${campaignId.slice(0,8)}] Kalshi placeKalshiOrder REJECTED ticker=${sess.kalshiTicker} ${ksSide}:`,
              r?.message || r,
              r?.stack ? `\n${r.stack}` : '',
            );
          }

          const kalshiOrder = kalshiOk ? kalshiResult.value?.order : null;
          const ksOrderId = kalshiOrder?.order_id || null;
          const ksFilled = kalshiOrder ? parseFloat(kalshiOrder.fill_count_fp || '0') : 0;
          const kalshiTakerCost = kalshiOrder ? parseFloat(kalshiOrder.taker_fill_cost_dollars || '0') : 0;
          const kalshiMakerCost = kalshiOrder ? parseFloat(kalshiOrder.maker_fill_cost_dollars || '0') : 0;
          const kalshiFillCost = kalshiTakerCost + kalshiMakerCost;
          const kalshiRealPrice = ksFilled > 0 ? kalshiFillCost / ksFilled : ksIocCents / 100;
          const kalshiFees = parseFloat(kalshiOrder?.taker_fees_dollars || '0') + parseFloat(kalshiOrder?.maker_fees_dollars || '0');

          const polyRaw = polyOk ? polyResult.value : null;
          const polyStatus = polyOk ? (polyRaw?.status || 'sent') : 'failed';
          const polyMakingAmt = polyOk ? parseFloat(polyRaw?.makingAmount || '0') : 0;
          const polyTakingAmt = polyOk ? parseFloat(polyRaw?.takingAmount || '0') : 0;
          const polyMatched = polyStatus === 'matched';
          const polyFilled = polyMatched && polyTakingAmt > 0;
          const polyActualPrice = polyTakingAmt > 0 && polyMakingAmt > 0 ? polyMakingAmt / polyTakingAmt : polyPrice;
          const polyOrderId = polyOk ? (polyRaw?.orderID || polyRaw?.id || null) : null;
          const polyErrMsg = !polyOk ? polyResult.reason?.message : (!polyFilled ? `status=${polyStatus} taking=${polyTakingAmt}` : null);

          if (ksOrderId && ksFilled < SHARES) {
            try { await kalshiFetch(`${KALSHI_TRADE_API}/portfolio/orders/${ksOrderId}`, { method: 'DELETE' }); } catch {}
          }

          const polySideLabel = bestStrategy === 'A' ? 'down' : 'up';
          const sigDiv = ksYesAsk != null && polyUpAsk != null ? Math.abs(((ksYesBid || 0) + (ksYesAsk || 0)) / 2 - polyUpAsk) : null;
          const sigSpread = ksAskPrice / 100 + polyAsk;
          const hedged = Math.min(ksFilled, polyTakingAmt || 0);
          const realTotalCost = kalshiFillCost + (polyMakingAmt || 0);
          const expectedPayout = hedged;
          const realProfit = expectedPayout - kalshiFees - realTotalCost;

          console.log(`[arb:${campaignId.slice(0,8)}] RESULT parallel: KS filled ${ksFilled}/${SHARES} | Poly ${polyStatus} ${polyTakingAmt.toFixed(1)}sh | BOTH=${ksFilled > 0 && polyFilled}`);
          if (kalshiOk && ksFilled < 0.001) {
            console.error(`[arb:${campaignId.slice(0,8)}] Kalshi IOC returned 0 fills — order:`, JSON.stringify(kalshiOrder || {}).slice(0, 600));
          }

          await pool.query(
            `INSERT INTO arb_trades (session_id, strategy, kalshi_ticker, kalshi_side, kalshi_limit_cents, kalshi_filled, kalshi_fill_price, kalshi_shares, kalshi_order_id, kalshi_error, poly_token_id, poly_side, poly_limit_price, poly_filled, poly_fill_price, poly_shares, poly_order_id, poly_error, both_filled, total_cost, expected_payout, expected_profit, signal_ks_yes_bid, signal_ks_yes_ask, signal_ks_no_bid, signal_ks_no_ask, signal_poly_up_ask, signal_poly_down_ask, signal_divergence, signal_spread, signal_ks_yes_ask_qty, signal_ks_no_ask_qty, signal_poly_up_ask_qty, signal_poly_down_ask_qty, signal_poly_up_depth_2c, signal_poly_down_depth_2c, mode, event_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)`,
            [
              state.currentSessionId, bestStrategy, sess.kalshiTicker, ksSide, ksIocCents,
              ksFilled > 0, kalshiRealPrice, Math.round(ksFilled), ksOrderId,
              kalshiOk ? null : kalshiResult.reason?.message,
              polyTokenId, polySideLabel, polyPrice,
              polyFilled, polyActualPrice, Math.round(polyTakingAmt || 0), polyOrderId,
              polyErrMsg,
              ksFilled > 0 && polyFilled,
              realTotalCost, expectedPayout, realProfit,
              ksYesBid, ksYesAsk, ksNoBid, ksNoAsk, polyUpAsk, polyDownAsk, sigDiv, sigSpread,
              ksYQty, ksNQty, polyUp?.bestAskQty ?? null, polyDn?.bestAskQty ?? null, polyUp?.depthAt2c ?? upLiq ?? null, polyDn?.depthAt2c ?? downLiq ?? null,
              'taker', eventId,
            ],
          ).catch(e => console.error('[arb] DB insert error:', e.message));

          if (polyOk && !polyFilled) {
            console.log(`[arb:${campaignId.slice(0,8)}] WARNING: Poly order ${polyStatus} not matched — may be resting (takingAmt=${polyTakingAmt})`);
          }

          if (!polyFilled) {
            state.polyFailCount = (state.polyFailCount || 0) + 1;
            if (state.polyFailCount >= 3) {
              console.log(`[arb:${campaignId.slice(0,8)}] 3 Poly failures — STOPPING`);
              await pool.query('UPDATE arb_campaigns SET auto_enabled = false, status = $1, stopped_at = NOW() WHERE id = $2', ['stopped', campaignId]).catch(() => {});
              stopped = true;
              return;
            }
          } else {
            state.polyFailCount = 0;
            if (ksFilled > 0 && state.swapPoly) state.nextStrategy = bestStrategy === 'A' ? 'B' : 'A';
            await pool.query('UPDATE arb_campaigns SET total_trades = total_trades + 1, last_trade_at = NOW() WHERE id = $1', [campaignId]).catch(() => {});
          }
        }
      } catch (e) {
        console.error(`[arb:${campaignId.slice(0,8)}] Trade error:`, e.message?.slice(0, 100));
      }

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
    console.log(`[auto-campaign:${campaignId.slice(0,8)}] Started (threshold: ${thresholdCents}¢, cooldown: ${cooldownSec}s, maxShares: ${maxShares})${tag}`);
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
      const { autoEnabled, autoThreshold, autoCooldown, swapPoly, earlyExit, exitThreshold, maxShares } = req.body;
      const maxSharesSafe = maxShares == null ? null : Math.max(1, Math.min(1000, parseInt(maxShares, 10) || GLOBAL_MAX_SHARES));

      const r = await pool.query('SELECT * FROM arb_campaigns WHERE id = $1', [id]);
      const campaign = r.rows[0];
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

      // Update DB — also set status when enabling/disabling
      const newStatus = autoEnabled === true ? 'running' : autoEnabled === false ? 'stopped' : null;
      await pool.query(
        `UPDATE arb_campaigns SET auto_enabled = COALESCE($1, auto_enabled), auto_threshold_cents = COALESCE($2, auto_threshold_cents), auto_cooldown_sec = COALESCE($3, auto_cooldown_sec), swap_poly = COALESCE($4, swap_poly), early_exit = COALESCE($5, early_exit), exit_threshold_cents = COALESCE($6, exit_threshold_cents), max_shares = COALESCE($7, max_shares)${newStatus ? ', status = \'' + newStatus + '\'' : ''}${autoEnabled === false ? ', stopped_at = NOW()' : ''} WHERE id = $8`,
        [autoEnabled, autoThreshold, autoCooldown, swapPoly, earlyExit, exitThreshold, maxSharesSafe, id],
      );

      // Start/stop auto
      const existing = campaigns.get(id);
      if (existing && maxSharesSafe != null && existing.state) {
        existing.state.maxShares = maxSharesSafe;
      }
      if (existing && swapPoly != null && existing.state) {
        // Apply swap toggle live; next tick/trade uses the new side mapping.
        existing.state.swapPoly = !!swapPoly;
        // Alternation is tied to swap toggle. Turning swap off disables flip queue.
        if (!existing.state.swapPoly) existing.state.nextStrategy = null;
      }
      if (autoEnabled && !existing && campaign.session_id) {
        startCampaignAuto(
          id,
          campaign.session_id,
          autoThreshold || campaign.auto_threshold_cents,
          autoCooldown || campaign.auto_cooldown_sec,
          swapPoly ?? campaign.swap_poly,
          campaign.recurring || false,
          null,
          campaign.early_exit || false,
          campaign.exit_threshold_cents || 4,
          maxSharesSafe || campaign.max_shares || GLOBAL_MAX_SHARES,
          looksPolymarketUrl(String(campaign.kalshi_url)) && looksPolymarketUrl(String(campaign.poly_url)),
        );
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
            startCampaignAuto(
              c.id,
              sessionId,
              c.auto_threshold_cents || 3,
              c.auto_cooldown_sec || 60,
              c.swap_poly || false,
              c.recurring || false,
              recurringType,
              c.early_exit || false,
              c.exit_threshold_cents || 4,
              c.max_shares || GLOBAL_MAX_SHARES,
              looksPolymarketUrl(String(c.kalshi_url)) && looksPolymarketUrl(String(c.poly_url)),
            );
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

  async function venuePnlTick() {
    try {
      const { refreshPendingVenuePnlSessions } = await import('./sessionVenuePnl.mjs');
      await refreshPendingVenuePnlSessions(pool);
    } catch (e) {
      console.error('[venue-pnl] tick', e.message?.slice(0, 80));
    }
  }
  // Run quickly on boot so Venue P&L table fills without waiting.
  setTimeout(venuePnlTick, 3000);
  setInterval(venuePnlTick, 5 * 60 * 1000);

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
