import React, { useState, useEffect } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function EndingSoon() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());

  // Tick every second for countdowns
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  // Fetch events ending soon
  useEffect(() => {
    async function load() {
      try {
        const r = await fetch(`${API_BASE}/api/ending-soon`);
        const filtered = await r.json();
        setEvents(Array.isArray(filtered) ? filtered : []);
      } catch (e) {
        console.error('Failed to load events:', e);
      }
      setLoading(false);
    }
    load();
    const iv = setInterval(load, 60000); // refresh every minute
    return () => clearInterval(iv);
  }, []);

  function formatCountdown(endDate) {
    const ms = new Date(endDate).getTime() - now;
    if (ms <= 0) return 'ENDED';
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
    return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
  }

  function urgencyColor(endDate) {
    const ms = new Date(endDate).getTime() - now;
    if (ms <= 0) return 'text-gray-500';
    if (ms < 3600000) return 'text-red-400 animate-pulse'; // < 1h
    if (ms < 86400000) return 'text-orange-400'; // < 1 day
    return 'text-yellow-400';
  }

  // Buy 99¢ on winning side
  async function buy99(market) {
    // Determine winning side from market data
    const outcomePrices = market.outcomePrices ? JSON.parse(market.outcomePrices) : null;
    if (!outcomePrices || outcomePrices.length < 2) return alert('No price data');

    const p0 = parseFloat(outcomePrices[0]);
    const p1 = parseFloat(outcomePrices[1]);
    const winIdx = p0 >= p1 ? 0 : 1;
    const outcomes = market.outcomes ? JSON.parse(market.outcomes) : ['Yes', 'No'];
    const winOutcome = outcomes[winIdx];

    // Get token IDs
    const tokens = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : null;
    if (!tokens || !tokens[winIdx]) return alert('No token ID');

    const tokenId = tokens[winIdx];
    const tickSize = market.minimumTickSize || '0.01';
    const negRisk = market.negRisk || false;

    try {
      const res = await fetch(`${API_BASE}/api/poly/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenId,
          shares: 5,
          limitPrice: 0.99,
          orderType: 'GTC',
          tickSize,
          negRisk,
        }),
      });
      const d = await res.json();
      alert(`${winOutcome} 5sh @ 99¢: ${d.status || d.error || 'sent'}`);
    } catch (e) {
      alert('Error: ' + e.message);
    }
  }

  const [live99, setLive99] = useState(false);
  const [live99Status, setLive99Status] = useState({});

  // Poll live-99 status
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/live99/status`);
        const d = await r.json();
        setLive99(d.enabled);
        setLive99Status(d);
      } catch {}
    }, 3000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-white">Events Ending Soon</h2>
          <button
            onClick={async () => {
              try {
                const r = await fetch(`${API_BASE}/api/live99/toggle`, { method: 'POST' });
                const d = await r.json();
                setLive99(d.enabled);
              } catch {}
            }}
            className={`px-3 py-1 rounded text-xs font-bold border transition-colors ${live99 ? 'bg-cyan-600 text-white border-cyan-400 animate-pulse' : 'bg-gray-800 text-gray-400 border-gray-600 hover:bg-gray-700'}`}
          >
            {live99 ? `AUTO-99 ON (${live99Status.tracking || 0} tracking)` : 'Auto-99 Live'}
          </button>
        </div>
        <span className="text-[10px] text-gray-500">{events.length} events | refreshes every 60s</span>
      </div>

      {/* Live-99 log */}
      {live99Status.log?.length > 0 && (
        <div className="px-3 py-2 rounded-lg bg-cyan-900/20 border border-cyan-800/30 space-y-1">
          <span className="text-[10px] text-cyan-400 font-bold">Recent Auto-99 Orders</span>
          {live99Status.log.slice(0, 5).map((l, i) => (
            <div key={i} className="text-[10px] font-mono text-gray-300">
              {l.event?.slice(0, 30)} | {l.side} @ {l.price} | {l.status} | {l.score}
            </div>
          ))}
        </div>
      )}

      {loading && <p className="text-gray-500 text-sm">Loading...</p>}

      <div className="space-y-1">
        {events.map((m, i) => {
          const isLive = m._live;
          const countdown = formatCountdown(m.endDate);
          const ended = !isLive && countdown === 'ENDED';
          const matchEnded = m._ended;
          const outcomePrices = m.outcomePrices ? JSON.parse(m.outcomePrices) : null;
          const outcomes = m.outcomes ? JSON.parse(m.outcomes) : ['Yes', 'No'];
          const p0 = outcomePrices ? (parseFloat(outcomePrices[0]) * 100).toFixed(0) : '?';
          const p1 = outcomePrices ? (parseFloat(outcomePrices[1]) * 100).toFixed(0) : '?';
          const vol = m.volume ? '$' + (parseFloat(m.volume) / 1000).toFixed(0) + 'k' : '';
          const score = m._score;
          const period = m._period;
          const title = m._eventTitle || m.question || m.groupItemTitle;

          return (
            <div key={m.conditionId || i} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${ended ? 'border-gray-800 bg-gray-900/30 opacity-50' : isLive ? 'border-red-800/50 bg-gray-900/80' : 'border-gray-800 bg-gray-900/60 hover:bg-gray-800/60'}`}>
              {/* Live badge or countdown */}
              <div className="w-24 text-right">
                {isLive ? (
                  <div>
                    <span className="text-red-500 text-[10px] font-bold animate-pulse">● LIVE</span>
                    {period && <div className="text-[9px] text-gray-400">{period}</div>}
                  </div>
                ) : (
                  <div className={`font-mono text-sm font-bold ${urgencyColor(m.endDate)}`}>{countdown}</div>
                )}
              </div>

              {/* Event info */}
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-gray-200 truncate">{title}</div>
                <div className="text-[9px] text-gray-500 flex gap-2">
                  {score && <span className="text-white font-bold">{score}</span>}
                  {!isLive && <span>{new Date(m.endDate).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}</span>}
                  <span>{vol}</span>
                </div>
              </div>

              {/* Prices */}
              <div className="flex gap-2 text-[10px] font-mono">
                <span className="text-green-400">{outcomes[0]?.slice(0, 10)} {p0}¢</span>
                <span className="text-red-400">{outcomes[1]?.slice(0, 10)} {p1}¢</span>
              </div>

              {/* 99¢ button */}
              <button
                onClick={() => buy99(m)}
                disabled={ended}
                className="px-2 py-1 rounded bg-yellow-600 hover:bg-yellow-500 disabled:opacity-30 text-black text-[10px] font-bold whitespace-nowrap"
              >
                99¢
              </button>
            </div>
          );
        })}
      </div>

      {!loading && events.length === 0 && (
        <p className="text-gray-500 text-sm text-center py-8">No non-crypto events ending within 7 days</p>
      )}
    </div>
  );
}
