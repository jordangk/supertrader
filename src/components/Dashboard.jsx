import React, { useState, useEffect } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const r = await fetch(`${API_BASE}/api/dashboard`);
        setData(await r.json());
      } catch (e) {
        console.error('Dashboard error:', e);
      }
      setLoading(false);
    }
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, []);

  if (loading) return <p className="text-gray-500 p-4">Loading dashboard...</p>;
  if (!data) return <p className="text-red-500 p-4">Failed to load</p>;

  const { liveEvents, openOrders, positions, scanners, recentLog } = data;

  return (
    <div className="space-y-4 p-4 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">SuperTrader Dashboard</h1>
        <div className="flex gap-3 text-xs">
          <span className="px-2 py-1 rounded bg-green-900 text-green-300">{positions.won} won</span>
          <span className="px-2 py-1 rounded bg-red-900 text-red-300">{positions.lost} lost</span>
          <span className="px-2 py-1 rounded bg-yellow-900 text-yellow-300">{positions.open} open</span>
          <span className="px-2 py-1 rounded bg-blue-900 text-blue-300">{openOrders} orders</span>
        </div>
      </div>

      {/* P&L Summary */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-3 text-center">
          <div className="text-[10px] text-gray-500 uppercase">Positions</div>
          <div className="text-lg font-bold text-white">{positions.total}</div>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-3 text-center">
          <div className="text-[10px] text-gray-500 uppercase">Cost</div>
          <div className="text-lg font-bold text-white">${positions.cost?.toFixed(2)}</div>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-3 text-center">
          <div className="text-[10px] text-gray-500 uppercase">Value</div>
          <div className="text-lg font-bold text-white">${positions.value?.toFixed(2)}</div>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-3 text-center">
          <div className="text-[10px] text-gray-500 uppercase">P&L</div>
          <div className={`text-lg font-bold ${positions.value - positions.cost >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            ${(positions.value - positions.cost)?.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Scanners */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-3">
        <h2 className="text-sm font-bold text-white mb-2">Scanners</h2>
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          {Object.entries(scanners).map(([name, s]) => (
            <div key={name} className={`px-2 py-1 rounded ${s.active ? 'bg-green-900/30 text-green-300' : 'bg-gray-800 text-gray-500'}`}>
              <span className="font-bold">{s.active ? '●' : '○'} {name}</span>
              {s.tracked != null && <span className="ml-1">({s.tracked} tracked)</span>}
              {s.matched != null && <span className="ml-1">({s.matched} matched)</span>}
              {s.cities != null && <span className="ml-1">({s.cities} cities)</span>}
            </div>
          ))}
        </div>
      </div>

      {/* PandaScore Lag */}
      {scanners.pandaScore?.lagLog?.length > 0 && (
        <div className="rounded-xl border border-cyan-800/30 bg-cyan-900/10 p-3">
          <h2 className="text-sm font-bold text-cyan-300 mb-2">PandaScore Lag</h2>
          <div className="space-y-1">
            {scanners.pandaScore.lagLog.map((l, i) => (
              <div key={i} className="text-[10px] font-mono text-gray-300">
                {l.event} Map {l.map} — Gamma lag: {(l.lagMs / 1000).toFixed(1)}s
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Events */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-3">
        <h2 className="text-sm font-bold text-white mb-2">Live Events ({liveEvents.length})</h2>
        <div className="space-y-1 max-h-60 overflow-y-auto">
          {liveEvents.map((e, i) => {
            const isEsports = e.score?.includes('|');
            const isTennis = e.score?.includes(',');
            const cat = isEsports ? '🎮' : isTennis ? '🎾' : '⚽';
            return (
              <div key={i} className="flex items-center gap-2 text-[11px] px-2 py-1 rounded bg-gray-800/50">
                <span>{cat}</span>
                <span className="flex-1 text-gray-200 truncate">{e.title}</span>
                <span className="font-mono text-yellow-400">{e.score}</span>
                <span className="text-gray-500">{e.period}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Log */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-3">
        <h2 className="text-sm font-bold text-white mb-2">Recent Orders</h2>
        <div className="space-y-1 max-h-60 overflow-y-auto">
          {(recentLog || []).map((l, i) => (
            <div key={i} className="text-[10px] font-mono text-gray-300 px-2 py-1 rounded bg-gray-800/30">
              {l.event?.slice(0, 25)} | {l.market?.slice(0, 30)} | {l.side} {l.price} | {l.status}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
