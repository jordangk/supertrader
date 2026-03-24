import React, { useMemo, useState, useEffect } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function WhaleFeed({ whaleTrades = [], maxBuckets = 0, eventSlug = null }) {
  const [holdings, setHoldings] = useState(null);
  const [positions, setPositions] = useState(null);
  const [apiTrades, setApiTrades] = useState([]);

  useEffect(() => {
    const slug = eventSlug || undefined;
    fetch(`${API_BASE}/api/whale-holdings${slug ? `?slug=${encodeURIComponent(slug)}` : ''}`)
      .then(r => r.json())
      .then(d => setHoldings(d))
      .catch(() => {});
  }, [whaleTrades.length, eventSlug]);

  useEffect(() => {
    const q = eventSlug ? `?event=${encodeURIComponent(eventSlug)}` : '';
    fetch(`${API_BASE}/api/whale-positions${q}`)
      .then(r => r.json())
      .then(d => setPositions(d))
      .catch(() => {});
  }, [eventSlug, whaleTrades.length]);

  // Hydrate from persisted trades (DB)
  useEffect(() => {
    if (!eventSlug || !eventSlug.includes('-15m-')) return;
    fetch(`${API_BASE}/api/whale-trades?slug=${encodeURIComponent(eventSlug)}&limit=1000`)
      .then(r => r.json())
      .then(d => setApiTrades(d.trades || []))
      .catch(() => setApiTrades([]));
  }, [eventSlug]);

  // Merge persisted (API) + live (WS); dedupe by tx_hash
  const trades = useMemo(() => {
    const seen = new Set();
    const out = [];
    const slugFilter = t => eventSlug == null || t.slug === eventSlug;
    for (const t of whaleTrades) {
      if (!slugFilter(t)) continue;
      const k = t.tx_hash || `ws-${t.ts}-${t.outcome}-${t.shares}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    for (const t of apiTrades) {
      if (!eventSlug || t.slug !== eventSlug) continue;
      const k = t.tx_hash || `api-${t.ts}-${t.outcome}-${t.shares}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }, [whaleTrades, apiTrades, eventSlug]);

  // Live holdings from displayed trades (running net: buy adds, sell subtracts)
  const liveHoldings = useMemo(() => {
    let up = 0, down = 0;
    for (const t of trades) {
      const sh = parseFloat(t.shares) || 0;
      const delta = t.side === 'buy' ? sh : -sh;
      if (/up/i.test(t.outcome)) up += delta;
      else down += delta;
    }
    return { up: Math.round(up * 100) / 100, down: Math.round(down * 100) / 100 };
  }, [trades]);

  // Flat list: every transaction, no nesting
  const flatTrades = useMemo(() => {
    return [...trades].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }, [trades]);

  const hasDbHoldings = holdings && (eventSlug?.includes('-15m-') || !eventSlug);
  const hasPolymarketPos = positions && !positions.error && positions.positions?.length > 0 && !eventSlug?.includes('-15m-');
  const showHoldings = hasDbHoldings || hasPolymarketPos || trades.length > 0;

  return (
    <div className="space-y-2">
      {/* Whale holdings — prominent, always shown when we have data */}
      {showHoldings && (
        <div className="rounded-xl border-2 border-cyan-700/60 bg-cyan-950/40 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-sm font-bold text-cyan-400">🐋 @0x8dxd Holdings</span>
          {hasDbHoldings && (
            <span className="text-xs">
              <span className="text-gray-500">DB:</span>
              <span className="text-green-400 font-mono font-bold ml-1">{(holdings.up ?? 0).toFixed(1)} Up</span>
              <span className="text-red-400 font-mono font-bold ml-1">{(holdings.down ?? 0).toFixed(1)} Down</span>
              {holdings.slug && <span className="text-gray-600 font-mono ml-1">{holdings.slug?.match(/-(\d+)$/)?.[1] || ''}</span>}
            </span>
          )}
          {trades.length > 0 && (
            <span className="text-xs">
              <span className="text-gray-500">From feed:</span>
              <span className="text-green-400 font-mono font-bold ml-1">{liveHoldings.up.toFixed(1)} Up</span>
              <span className="text-red-400 font-mono font-bold ml-1">{liveHoldings.down.toFixed(1)} Down</span>
            </span>
          )}
          {hasPolymarketPos && (
            <span className="text-xs">
              <span className="text-gray-500">Polymarket:</span>
              <span className="text-green-400 font-mono ml-1">{(positions.totalUp ?? 0).toFixed(1)} Up</span>
              <span className="text-red-400 font-mono ml-1">{(positions.totalDown ?? 0).toFixed(1)} Down</span>
              <span className="text-yellow-400 font-mono ml-1">${(positions.totalValue ?? 0).toFixed(2)}</span>
            </span>
          )}
        </div>
      )}

      {!flatTrades.length && (
        <div className="text-center text-gray-600 text-sm py-4">
          {eventSlug?.includes('-15m-') ? 'No whale trades for this event yet.' : 'Select a 15m event or wait for whale trades.'}
        </div>
      )}

      <div className="max-h-[600px] overflow-y-auto space-y-1">
      {flatTrades.map((t, i) => {
        const isBuy = t.side === 'buy';
        const isUp = /up/i.test(t.outcome);
        const shares = parseFloat(t.shares) || 0;
        const usdc = Math.abs(parseFloat(t.usdc) || 0);
        const avgPrice = shares > 0 ? (usdc / shares) : 0;
        const mktPrice = isUp ? t.marketUp : t.marketDown;
        const mktCents = mktPrice != null ? (mktPrice * 100).toFixed(0) : null;
        const cheaper = mktCents != null && avgPrice < mktPrice;
        const sizeClass = usdc >= 50 ? 'border-yellow-500/60' : usdc >= 20 ? 'border-cyan-700/50' : 'border-gray-800/50';
        const key = t.tx_hash || `t-${t.ts}-${i}`;

        return (
          <div key={key} className={`rounded border ${sizeClass} bg-gray-900/60 px-3 py-1.5 flex items-center justify-between gap-2 flex-wrap`}>
            <span className="text-gray-500 text-[10px] font-mono">{timeAgo(t.ts)}</span>
            <span className={`font-bold ${isBuy ? 'text-green-400' : 'text-red-400'}`}>
              {isBuy ? 'BUY' : 'SELL'}
            </span>
            <span className={`font-bold ${isUp ? 'text-green-300' : 'text-red-300'}`}>
              {shares.toFixed(1)} {isUp ? 'Up' : 'Down'}
            </span>
            <span className="text-gray-400">at {(avgPrice * 100).toFixed(0)}¢</span>
            {mktCents != null && (
              <span className={cheaper ? 'text-green-400/90 font-mono' : 'text-gray-500 font-mono'}>
                (mkt {mktCents}¢)
              </span>
            )}
            <span className="text-yellow-400 font-mono font-bold">${usdc.toFixed(2)}</span>
          </div>
        );
      })}
      </div>
    </div>
  );
}
