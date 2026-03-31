/**
 * Per-session P&L from venue sources: Kalshi GET /portfolio/fills (+ /historical/fills)
 * and Polymarket https://data-api.polymarket.com/trades (not our arb_trades ledger).
 * Settlement uses Kalshi GET /markets/{ticker} result and gamma-api event outcome for Poly.
 */
import { kalshiFetch, hasKalshiAuth } from './kalshiAuth.mjs';
import { KALSHI_TRADE_API } from './kalshiPrice.mjs';

const WINDOW_SEC_15M = 15 * 60;

function num(x) {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}

function parsePoly15mSlug(slug) {
  const s = String(slug || '').toLowerCase();
  const m = s.match(/^(btc|eth|sol)-updown-15m-(\d{10})$/);
  if (!m) return null;
  const asset = m[1];
  const start = parseInt(m[2], 10);
  if (!Number.isFinite(start)) return null;
  return { asset, start, end: start + WINDOW_SEC_15M };
}

/** Cash flow from fills (fees included); net YES / NO contract inventory. */
export function kalshiLedgerFromFills(fills) {
  let cash = 0;
  let yesNet = 0;
  let noNet = 0;
  for (const f of fills) {
    const c = num(f.count_fp);
    const yp = num(f.yes_price_dollars);
    const np = num(f.no_price_dollars);
    cash -= num(f.fee_cost);
    if (f.side === 'yes' && f.action === 'buy') {
      cash -= c * yp;
      yesNet += c;
    } else if (f.side === 'yes' && f.action === 'sell') {
      cash += c * yp;
      yesNet -= c;
    } else if (f.side === 'no' && f.action === 'buy') {
      cash -= c * np;
      noNet += c;
    } else if (f.side === 'no' && f.action === 'sell') {
      cash += c * np;
      noNet -= c;
    }
  }
  return { cash, yesNet, noNet };
}

/** Full P&L in dollars once market result is known (binary). */
export function kalshiPnlWithResult(ledger, result) {
  const { cash, yesNet, noNet } = ledger;
  if (result === 'yes') return cash + yesNet;
  if (result === 'no') return cash + noNet;
  return null;
}

async function kalshiFetchFillsPath(pathWithQuery) {
  const out = [];
  const seen = new Set();
  let cursor = '';
  for (let page = 0; page < 200; page++) {
    const sep = pathWithQuery.includes('?') ? '&' : '?';
    const q = cursor ? `${pathWithQuery}${sep}cursor=${encodeURIComponent(cursor)}` : pathWithQuery;
    const url = `${KALSHI_TRADE_API}/${q.replace(/^\//, '')}`;
    const r = await kalshiFetch(url);
    if (!r.ok) break;
    const j = await r.json();
    const fills = j.fills || [];
    for (const f of fills) {
      const id = f.fill_id || f.trade_id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(f);
    }
    cursor = j.cursor || '';
    if (!cursor || fills.length === 0) break;
  }
  return out;
}

export async function fetchKalshiFillsForTicker(ticker) {
  const t = encodeURIComponent(ticker);
  const live = await kalshiFetchFillsPath(`portfolio/fills?ticker=${t}&limit=200`);
  const hist = await kalshiFetchFillsPath(`historical/fills?ticker=${t}&limit=200`);
  const seen = new Set();
  const merged = [];
  for (const f of [...live, ...hist]) {
    const id = f.fill_id || f.trade_id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.push(f);
  }
  return merged;
}

export async function fetchKalshiMarketResult(ticker) {
  const r = await kalshiFetch(`${KALSHI_TRADE_API}/markets/${encodeURIComponent(ticker)}`);
  if (!r.ok) return { status: null, result: null, error: `market ${r.status}` };
  const j = await r.json();
  const m = j.market || j;
  return {
    status: m.status || null,
    result: m.result === 'yes' || m.result === 'no' ? m.result : null,
    rawResult: m.result || '',
  };
}

export async function fetchPolymarketResolution(slug) {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
    if (!r.ok) return { closed: false, winner: null };
    const events = await r.json();
    if (!events?.length) return { closed: false, winner: null };
    const ev = events[0];
    if (!ev.closed) return { closed: false, winner: null };
    for (const m of ev.markets || []) {
      const prices = JSON.parse(m.outcomePrices || '[]');
      if (prices[0] === '1' || prices[0] === 1) return { closed: true, winner: 'Up' };
      if (prices[1] === '1' || prices[1] === 1) return { closed: true, winner: 'Down' };
    }
    return { closed: true, winner: null };
  } catch {
    return { closed: false, winner: null };
  }
}

export async function fetchPolymarketUserTradesForAssets(funder, assetSet) {
  if (!funder || !assetSet?.size) return [];
  const want = assetSet;
  const out = [];
  const seen = new Set();
  const limit = 500;
  for (let offset = 0; offset < 50000; offset += limit) {
    const url = `https://data-api.polymarket.com/trades?user=${encodeURIComponent(funder.toLowerCase())}&limit=${limit}&offset=${offset}`;
    const r = await fetch(url);
    if (!r.ok) break;
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const t of batch) {
      const aid = t.asset && String(t.asset);
      if (!aid || !want.has(aid)) continue;
      const key = `${t.transactionHash || ''}:${aid}:${t.timestamp}:${t.side}:${t.size}:${t.price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    if (batch.length < limit) break;
  }
  return out;
}

export function polymarketLedgerFromTrades(trades) {
  const byAsset = new Map();
  let cash = 0;
  for (const t of trades) {
    const aid = String(t.asset);
    const sz = num(t.size);
    const px = num(t.price);
    const usd = sz * px;
    const side = String(t.side || '').toUpperCase();
    if (side === 'BUY') cash -= usd;
    else if (side === 'SELL') cash += usd;
    const prev = byAsset.get(aid) || 0;
    if (side === 'BUY') byAsset.set(aid, prev + sz);
    else if (side === 'SELL') byAsset.set(aid, prev - sz);
  }
  return { cash, byAsset };
}

/** tokenId -> 'up' | 'down' */
export function polymarketPnlWithResolution(ledger, tokenSideMap, winner) {
  const { cash, byAsset } = ledger;
  if (!winner || (winner !== 'Up' && winner !== 'Down')) return null;
  let payout = 0;
  for (const [assetId, net] of byAsset) {
    const side = tokenSideMap.get(assetId);
    if (!side || net === 0) continue;
    const win =
      (winner === 'Up' && side === 'up') || (winner === 'Down' && side === 'down');
    if (win) payout += net;
  }
  return cash + payout;
}

/**
 * Load session instruments from arb_trades, pull venue data, write arb_sessions venue_* columns.
 * @returns {{ status: string, detail: object }}
 */
export async function computeAndStoreSessionVenuePnl(pool, sessionId) {
  const detail = { sessionId, kalshi: {}, polymarket: {} };
  const sess = await pool.query('SELECT id, polymarket_slug, ended_at FROM arb_sessions WHERE id = $1', [sessionId]);
  const row = sess.rows[0];
  if (!row) {
    return { status: 'error', detail: { ...detail, error: 'session_not_found' } };
  }

  const slot = parsePoly15mSlug(row.polymarket_slug);

  let tr = await pool.query(
    `SELECT
       t.session_id,
       kalshi_ticker, kalshi_side, kalshi_filled, kalshi_fill_price, kalshi_shares,
       poly_token_id, poly_side, poly_filled, poly_fill_price, poly_shares
     FROM arb_trades t
     WHERE t.session_id = $1
     ORDER BY t.ts ASC`,
    [sessionId],
  );
  let tradeRows = tr.rows || [];
  let rolledUpByEvent = false;

  if (tradeRows.length === 0 && slot) {
    // If session is empty, roll up by 15m close mark (asset + end epoch),
    // because the same event can be restarted into multiple session_ids.
    tr = await pool.query(
      `SELECT
         t.session_id,
         s.polymarket_slug,
         t.kalshi_ticker, t.kalshi_side, t.kalshi_filled, t.kalshi_fill_price, t.kalshi_shares,
         t.poly_token_id, t.poly_side, t.poly_filled, t.poly_fill_price, t.poly_shares
       FROM arb_trades t
       JOIN arb_sessions s ON s.id = t.session_id
       WHERE s.polymarket_slug ILIKE $1
       ORDER BY t.ts ASC`,
      [`${slot.asset}-updown-15m-%`],
    );
    tradeRows = (tr.rows || []).filter((r) => {
      const p = parsePoly15mSlug(r.polymarket_slug);
      return !!p && p.asset === slot.asset && p.end === slot.end;
    });
    rolledUpByEvent = tradeRows.length > 0;
  }
  if (rolledUpByEvent) {
    detail.rollup = {
      by: 'asset+15m_close',
      asset: slot?.asset || null,
      endEpoch: slot?.end || null,
      sessionIds: [...new Set(tradeRows.map((r) => r.session_id).filter(Boolean))],
    };
  }

  const kalshiTickers = [...new Set(tradeRows.map((r) => r.kalshi_ticker).filter(Boolean))];
  const tokenSideMap = new Map();
  const polyAssets = new Set();
  const localKalshi = new Map(); // ticker -> { cash, yesNet, noNet, fillCount, shares }
  const localPoly = { cash: 0, byAsset: new Map(), fillCount: 0, shares: 0 };

  for (const r of tradeRows) {
    // Track known Poly instruments/outcomes even if not filled yet.
    if (r.poly_token_id) {
      polyAssets.add(String(r.poly_token_id));
      const ps = String(r.poly_side || '').toLowerCase();
      if (ps === 'up' || ps === 'down') tokenSideMap.set(String(r.poly_token_id), ps);
    }

    // Local Kalshi ledger from recorded arb_trades fills.
    if (r.kalshi_ticker && r.kalshi_filled) {
      const side = String(r.kalshi_side || '').toLowerCase();
      const shares = Math.max(0, num(r.kalshi_shares));
      const px = Math.max(0, num(r.kalshi_fill_price));
      if (shares > 0 && (side === 'yes' || side === 'no')) {
        const t = String(r.kalshi_ticker);
        const prev = localKalshi.get(t) || { cash: 0, yesNet: 0, noNet: 0, fillCount: 0, shares: 0 };
        prev.cash -= shares * px;
        if (side === 'yes') prev.yesNet += shares;
        else prev.noNet += shares;
        prev.fillCount += 1;
        prev.shares += shares;
        localKalshi.set(t, prev);
      }
    }

    // Local Polymarket ledger from recorded arb_trades fills.
    if (r.poly_token_id && r.poly_filled) {
      const shares = Math.max(0, num(r.poly_shares));
      const px = Math.max(0, num(r.poly_fill_price));
      if (shares > 0) {
        const aid = String(r.poly_token_id);
        localPoly.cash -= shares * px;
        const prevNet = localPoly.byAsset.get(aid) || 0;
        localPoly.byAsset.set(aid, prevNet + shares);
        localPoly.fillCount += 1;
        localPoly.shares += shares;
      }
    }
  }

  let kPnl = null;
  let kResolved = false;
  let kBlocked = false;

  if (kalshiTickers.length === 0) {
    kPnl = 0;
    kResolved = true;
    detail.kalshi = { tickers: [], pnl: 0, note: 'no_kalshi_instrument' };
  } else if (!hasKalshiAuth()) {
    kBlocked = true;
    detail.kalshi = { tickers: kalshiTickers, error: 'no_kalshi_auth' };
  } else {
    let sum = 0;
    let allSettled = true;
    detail.kalshi.tickers = kalshiTickers;
    for (const ticker of kalshiTickers) {
      const local = localKalshi.get(ticker);
      let fills = [];
      let ledger = null;
      let source = 'arb_trades';
      if (local && local.shares > 0) {
        ledger = { cash: local.cash, yesNet: local.yesNet, noNet: local.noNet };
      } else {
        fills = await fetchKalshiFillsForTicker(ticker);
        ledger = kalshiLedgerFromFills(fills);
        source = 'kalshi_api';
      }
      const { result, rawResult, status } = await fetchKalshiMarketResult(ticker);
      const pnl = kalshiPnlWithResult(ledger, result);
      detail.kalshi[ticker] = {
        source,
        fillCount: local?.fillCount ?? fills.length,
        filledShares: local?.shares ?? null,
        marketStatus: status,
        result: rawResult || result,
        pnl,
      };
      if (pnl === null) allSettled = false;
      else sum += pnl;
    }
    if (allSettled) {
      kPnl = sum;
      kResolved = true;
    }
  }

  const funder = process.env.FUNDER_ADDRESS;
  let pPnl = null;
  let pResolved = false;
  let pBlocked = false;

  if (polyAssets.size === 0) {
    pPnl = 0;
    pResolved = true;
    detail.polymarket = { pnl: 0, note: 'no_poly_instrument' };
  } else {
    const res = await fetchPolymarketResolution(row.polymarket_slug);
    detail.polymarket.slug = row.polymarket_slug;
    detail.polymarket.closed = res.closed;
    detail.polymarket.winner = res.winner;
    detail.polymarket.source = localPoly.fillCount > 0 ? 'arb_trades' : 'polymarket_api';

    let ledger = null;
    let tradeCount = 0;
    if (localPoly.fillCount > 0) {
      ledger = { cash: localPoly.cash, byAsset: localPoly.byAsset };
      tradeCount = localPoly.fillCount;
    } else if (!funder) {
      pBlocked = true;
      detail.polymarket.error = 'no_FUNDER_ADDRESS';
    } else {
      const trades = await fetchPolymarketUserTradesForAssets(funder, polyAssets);
      ledger = polymarketLedgerFromTrades(trades);
      tradeCount = trades.length;
    }

    detail.polymarket.tradeCount = tradeCount;
    detail.polymarket.filledShares = localPoly.fillCount > 0 ? localPoly.shares : null;
    const pnl = ledger ? polymarketPnlWithResolution(ledger, tokenSideMap, res.winner) : null;
    detail.polymarket.pnl = pnl;
    if (pnl !== null) {
      pPnl = pnl;
      pResolved = true;
    }
  }

  const kContrib = kResolved ? kPnl : null;
  const pContrib = pResolved ? pPnl : null;
  const total =
    kResolved && pResolved ? Number((kPnl + pPnl).toFixed(6)) : null;

  let status = 'ok';
  if (kBlocked || pBlocked) status = 'partial';
  if (!kResolved || !pResolved) status = kBlocked || pBlocked ? 'partial' : 'pending';

  try {
    await pool.query(
      `UPDATE arb_sessions SET
         venue_pnl_kalshi = $2,
         venue_pnl_polymarket = $3,
         venue_pnl_total = $4,
         venue_pnl_status = $5,
         venue_pnl_detail = $6::jsonb,
         venue_pnl_computed_at = NOW()
       WHERE id = $1`,
      [sessionId, kContrib, pContrib, total, status, JSON.stringify(detail)],
    );
  } catch (e) {
    const msg = e.message || String(e);
    if (/venue_pnl/i.test(msg) && /column/i.test(msg)) {
      console.error('[venue-pnl] DB missing columns — run scripts/sql/arb_session_venue_pnl.sql');
    }
    throw e;
  }

  return { status, detail };
}

export async function refreshPendingVenuePnlSessions(pool) {
  const r = await pool.query(
    `SELECT id FROM arb_sessions
     WHERE ended_at IS NOT NULL
       AND (
         venue_pnl_status IS NULL
         OR venue_pnl_status = 'pending'
         OR venue_pnl_computed_at IS NULL
         OR venue_pnl_computed_at < NOW() - INTERVAL '30 minutes'
       )
     ORDER BY ended_at DESC
     LIMIT 15`,
  );
  for (const row of r.rows) {
    try {
      await computeAndStoreSessionVenuePnl(pool, row.id);
    } catch (e) {
      console.error('[venue-pnl] refresh', row.id, e.message?.slice(0, 120));
    }
  }
}
