/**
 * Kalshi market data + auth via RSA signing.
 * @see https://docs.kalshi.com/getting_started/quick_start_market_data
 */
import { kalshiFetch } from './kalshiAuth.mjs';

export const KALSHI_TRADE_API =
  process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';

/** Match Kalshi market tickers like KXNBAGAME-26MAR25BKNGSW-GSW or KXBTCD-26MAR2619-T68899.99 */
const TICKER_RE = /\b(KX[A-Z0-9]+(?:-[A-Z0-9.]+)+)\b/i;

/**
 * Extract market ticker from:
 * - Plain ticker: KXNBAGAME-26MAR25BKNGSW-GSW
 * - kalshi://TICKER
 * - Any string/URL containing a ticker substring
 */
export function extractKalshiTicker(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const proto = s.match(/^kalshi:\/\/([^/?#]+)/i);
  if (proto) return proto[1].trim().toUpperCase();
  const apiPath = s.match(/\/trade-api\/v2\/markets\/([^/?#]+)/i);
  if (apiPath) return apiPath[1].trim().toUpperCase();
  for (const part of s.split('/')) {
    const seg = part.match(TICKER_RE);
    if (seg) return seg[1].toUpperCase();
  }
  const m = s.match(TICKER_RE);
  return m ? m[1].toUpperCase() : null;
}

function midFromBidAsk(bid, ask, last) {
  if (!Number.isNaN(bid) && !Number.isNaN(ask)) return (bid + ask) / 2;
  if (!Number.isNaN(last)) return last;
  if (!Number.isNaN(bid)) return bid;
  if (!Number.isNaN(ask)) return ask;
  return null;
}

/**
 * Match-level URLs use event tickers (e.g. KXATPMATCH-26MAR25PAUFIL) with no player suffix.
 * Resolve to one concrete market via GET /markets?event_ticker=…
 */
async function resolveKalshiMarketTickerFromEvent(eventTicker) {
  const q = new URLSearchParams({ event_ticker: eventTicker, limit: '50' });
  try {
    const res = await kalshiFetch(`${KALSHI_TRADE_API}/markets?${q}`);
    const text = await res.text();
    if (!res.ok) return null;
    const j = JSON.parse(text);
    const list = j.markets;
    if (!Array.isArray(list) || list.length === 0) return null;
    const tickers = list.map((m) => m.ticker).filter(Boolean);
    const prefer = tickers.find((t) => /-PAU$/i.test(t));
    if (prefer) return prefer;
    const fil = tickers.find((t) => /-FIL$/i.test(t));
    if (fil) return fil;
    return tickers.sort()[0];
  } catch {
    return null;
  }
}

export async function fetchKalshiYesPrice(ticker) {
  const url = `${KALSHI_TRADE_API}/markets/${encodeURIComponent(ticker)}`;
  try {
    const res = await kalshiFetch(url);
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404) {
        const resolved = await resolveKalshiMarketTickerFromEvent(ticker);
        if (resolved && resolved !== ticker) return fetchKalshiYesPrice(resolved);
      }
      return {
        price: null,
        price_no: null,
        error: `Kalshi ${res.status}: ${text.slice(0, 200)}`,
        source: 'kalshi_api',
      };
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return { price: null, price_no: null, error: 'Kalshi: invalid JSON', source: 'kalshi_api' };
    }
    const m = j.market;
    if (!m) return { price: null, price_no: null, error: 'Kalshi: missing market', source: 'kalshi_api' };

    const yBid = parseFloat(m.yes_bid_dollars);
    const yAsk = parseFloat(m.yes_ask_dollars);
    const yLast = parseFloat(m.last_price_dollars);
    const nBid = parseFloat(m.no_bid_dollars);
    const nAsk = parseFloat(m.no_ask_dollars);

    let yesMid = midFromBidAsk(yBid, yAsk, yLast);
    let noMid = midFromBidAsk(nBid, nAsk, null);

    if (yesMid != null && noMid == null) noMid = 1 - yesMid;
    else if (noMid != null && yesMid == null) yesMid = 1 - noMid;

    if (yesMid == null || yesMid < 0 || yesMid > 1) {
      return {
        price: null,
        price_no: null,
        error: 'Kalshi: could not parse YES/NO prices',
        source: 'kalshi_api',
        raw: { ticker: m.ticker },
      };
    }

    return {
      price: yesMid,
      price_no: noMid != null && noMid >= 0 && noMid <= 1 ? noMid : 1 - yesMid,
      source: 'kalshi_api',
      raw: {
        ticker: m.ticker,
        title: m.title,
        yes_bid_dollars: m.yes_bid_dollars,
        yes_ask_dollars: m.yes_ask_dollars,
        no_bid_dollars: m.no_bid_dollars,
        no_ask_dollars: m.no_ask_dollars,
        last_price_dollars: m.last_price_dollars,
      },
    };
  } catch (e) {
    return { price: null, price_no: null, error: e.message || String(e), source: 'kalshi_api' };
  }
}
