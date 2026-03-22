import React, { useMemo, useState, useEffect } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function WhaleFeed({ whaleTrades = [], maxBuckets = 0 }) {
  const [holdings, setHoldings] = useState(null);

  // Fetch holdings on mount + whenever new whale trades arrive
  useEffect(() => {
    fetch(`${API_BASE}/api/whale-holdings`)
      .then(r => r.json())
      .then(d => setHoldings(d))
      .catch(() => {});
  }, [whaleTrades.length]);

  // Group trades into 3-second buckets
  const buckets = useMemo(() => {
    if (!whaleTrades.length) return [];
    const grouped = {};
    for (const t of whaleTrades) {
      const bucketTs = Math.floor(t.ts / 3000) * 3000;
      if (!grouped[bucketTs]) grouped[bucketTs] = { ts: bucketTs, trades: [] };
      grouped[bucketTs].trades.push(t);
    }
    const sorted = Object.values(grouped).sort((a, b) => b.ts - a.ts);
    return maxBuckets > 0 ? sorted.slice(0, maxBuckets) : sorted;
  }, [whaleTrades, maxBuckets]);

  return (
    <div className="space-y-2">
      {/* Holdings bar */}
      {holdings && (
        <div className="flex items-center gap-4 px-3 py-2 rounded-lg border border-gray-800/50 bg-gray-900/60 text-xs">
          <span className="text-gray-500 font-bold">@0x8dxd</span>
          <span className="text-green-400 font-mono font-bold">{holdings.up.toFixed(1)} Up</span>
          <span className="text-red-400 font-mono font-bold">{holdings.down.toFixed(1)} Down</span>
          <span className="text-gray-600 font-mono">{holdings.slug?.match(/-(\d+)$/)?.[1] || ''}</span>
        </div>
      )}

      {!buckets.length && (
        <div className="text-center text-gray-600 text-sm py-4">
          Waiting for whale trades...
        </div>
      )}

      {buckets.map((b) => {
        const agg = {};
        for (const t of b.trades) {
          const key = `${t.side}-${t.outcome}`;
          if (!agg[key]) agg[key] = { side: t.side, outcome: t.outcome, shares: 0, usdc: 0, count: 0 };
          agg[key].shares += t.shares;
          agg[key].usdc += t.usdc;
          agg[key].count++;
        }
        const entries = Object.values(agg);
        const totalUsdc = entries.reduce((s, e) => s + Math.abs(e.usdc), 0);
        const sizeClass = totalUsdc >= 50 ? 'border-yellow-500/60' : totalUsdc >= 20 ? 'border-cyan-700/50' : 'border-gray-800/50';

        return (
          <div key={b.ts} className={`rounded-lg border ${sizeClass} bg-gray-900/60 px-3 py-2`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-500 text-[10px] font-mono">{timeAgo(b.ts)}</span>
              <span className="text-yellow-400 text-[10px] font-mono font-bold">${totalUsdc.toFixed(2)}</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {entries.map((e, i) => {
                const isBuy = e.side === 'buy';
                const isUp = /up/i.test(e.outcome);
                const avgPrice = e.shares > 0 ? (e.usdc / e.shares) : 0;
                return (
                  <div key={i} className="flex items-center gap-1.5 text-xs">
                    <span className={`font-bold ${isBuy ? 'text-green-400' : 'text-red-400'}`}>
                      {isBuy ? 'BUY' : 'SELL'}
                    </span>
                    <span className={`font-bold ${isUp ? 'text-green-300' : 'text-red-300'}`}>
                      {e.shares.toFixed(1)} {isUp ? 'Up' : 'Down'}
                    </span>
                    <span className="text-gray-400">
                      at {(avgPrice * 100).toFixed(0)}¢
                    </span>
                    <span className="text-gray-600">
                      (${Math.abs(e.usdc).toFixed(2)})
                    </span>
                    {e.count > 1 && (
                      <span className="text-gray-600 text-[10px]">×{e.count}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
