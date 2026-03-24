import React, { useEffect, useState, useMemo } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceDot, Area,
} from 'recharts';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function usd(n) {
  const x = parseFloat(n);
  if (isNaN(x)) return '—';
  return '$' + (x >= 0 ? '+' : '') + x.toFixed(2);
}

function formatTime(epoch) {
  if (!epoch) return '—';
  return new Date(epoch * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Mini chart for a single event — shows BTC delta + Up/Down prices with buy/sell markers
function EventChart({ slug, trades }) {
  const [snapshots, setSnapshots] = useState(null);

  useEffect(() => {
    if (!slug) return;
    fetch(`${API_BASE}/api/price-history?slug=${encodeURIComponent(slug)}&limit=1000`)
      .then(r => r.json())
      .then(d => setSnapshots(d.snapshots || []))
      .catch(() => setSnapshots([]));
  }, [slug]);

  const chartData = useMemo(() => {
    if (!snapshots?.length) return [];
    const t0 = new Date(snapshots[0].observed_at).getTime();
    const btcOpen = snapshots[0].coin_price || snapshots[0].btc_price;
    return snapshots.map(s => {
      const t = new Date(s.observed_at).getTime();
      return {
        elapsed: Math.round((t - t0) / 1000),
        btcDelta: btcOpen && s.coin_price ? s.coin_price - btcOpen : null,
        upPrice: s.up_cost != null ? Math.round(s.up_cost * 100) : null,
        downPrice: s.down_cost != null ? Math.round(s.down_cost * 100) : null,
      };
    });
  }, [snapshots]);

  // Map our trades onto elapsed time axis
  const tradeMarkers = useMemo(() => {
    if (!snapshots?.length || !trades?.length) return [];
    const t0 = new Date(snapshots[0].observed_at).getTime();
    const tEnd = new Date(snapshots[snapshots.length - 1].observed_at).getTime();
    return trades.filter(t => t.who === 'us' && t.ts).map(t => {
      const tMs = t.ts * 1000;
      if (tMs < t0 || tMs > tEnd + 5000) return null;
      return {
        elapsed: Math.round((tMs - t0) / 1000),
        price: Math.round(t.price * 100),
        side: t.side,
        outcome: t.outcome,
        shares: t.shares,
      };
    }).filter(Boolean);
  }, [snapshots, trades]);

  if (snapshots === null) return <div className="text-gray-600 text-xs py-2">Loading chart…</div>;
  if (!chartData.length) return <div className="text-gray-600 text-xs py-2">No price data for this event</div>;

  const fmtElapsed = (v) => {
    const m = Math.floor(v / 60);
    const s = v % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="mt-2">
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="elapsed" tickFormatter={fmtElapsed} stroke="#666" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis yAxisId="btc" orientation="left" width={45} stroke="#eab308" tick={{ fontSize: 10 }}
            tickFormatter={v => `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(0)}`} domain={['auto', 'auto']} />
          <YAxis yAxisId="poly" orientation="right" width={35} stroke="#4ade80" tick={{ fontSize: 10 }}
            tickFormatter={v => `${v}¢`} domain={[0, 100]} />
          <Tooltip formatter={(v, name) => {
            if (name === 'btcDelta') return [`$${v?.toFixed(1)}`, 'BTC Δ'];
            return [`${v}¢`, name === 'upPrice' ? 'Up' : 'Down'];
          }} labelFormatter={fmtElapsed} contentStyle={{ background: '#1a1a2e', border: '1px solid #333', fontSize: 11 }} />
          <ReferenceLine yAxisId="btc" y={0} stroke="#555" strokeDasharray="3 3" />
          <Area yAxisId="btc" dataKey="btcDelta" stroke="#eab308" fill="#eab30822" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
          <Line yAxisId="poly" dataKey="upPrice" stroke="#4ade80" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
          <Line yAxisId="poly" dataKey="downPrice" stroke="#f87171" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
          {tradeMarkers.map((m, i) => (
            <ReferenceDot key={`trade-${i}`} yAxisId="poly" x={m.elapsed} y={m.price} r={5}
              fill={m.side === 'buy' ? '#22d3ee' : '#f59e0b'}
              stroke={m.outcome === 'Up' ? '#4ade80' : '#f87171'}
              strokeWidth={2}
              label={{ value: `${m.side === 'buy' ? 'B' : 'S'}${m.price}¢`, position: m.side === 'buy' ? 'top' : 'bottom', fill: m.side === 'buy' ? '#22d3ee' : '#f59e0b', fontSize: 9, fontWeight: 'bold' }} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex items-center justify-center gap-4 text-[10px] mt-1">
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-yellow-500 inline-block"></span> BTC $</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-green-400 inline-block"></span> Up</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-red-400 inline-block"></span> Down</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cyan-400 inline-block"></span> Buy</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block"></span> Sell</span>
      </div>
    </div>
  );
}

export default function MyTrades() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [detailCache, setDetailCache] = useState({});

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE || ''}/api/k9-compare?slugs=auto`);
      const d = await r.json();
      const list = d.events || [];
      list.sort((a, b) => {
        const ea = parseInt((a.slug?.match(/(\d{10,})/) || [])[1] || 0);
        const eb = parseInt((b.slug?.match(/(\d{10,})/) || [])[1] || 0);
        return eb - ea;
      });
      setEvents(list);
    } catch {
      setEvents([]);
    }
    setLoading(false);
  }

  async function loadDetail(slug) {
    if (detailCache[slug]) return;
    try {
      const r = await fetch(`${API_BASE || ''}/api/event-detail/${encodeURIComponent(slug)}`);
      const d = await r.json();
      setDetailCache(c => ({ ...c, [slug]: d }));
    } catch {}
  }

  function toggleExpand(slug) {
    setExpanded(p => ({ ...p, [slug]: !p[slug] }));
    if (!expanded[slug]) loadDetail(slug);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  // Running P&L total
  const totalPnl = useMemo(() => {
    return events.reduce((sum, ev) => sum + (ev.ours?.pnl || 0), 0);
  }, [events]);

  if (loading) return (
    <div className="text-gray-500 text-sm p-4">Loading your trades…</div>
  );

  if (!events.length) return (
    <div className="text-gray-500 text-sm p-4">No trades found.</div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-300">My Trades</h2>
          <p className="text-xs text-gray-500 mt-0.5">{events.length} events traded. Click to expand chart + transactions.</p>
        </div>
        <div className="text-right">
          <span className="text-xs text-gray-500">Total P&L: </span>
          <span className={`text-sm font-bold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {usd(totalPnl)}
          </span>
        </div>
      </div>

      <div className="space-y-1">
        {events.map(ev => {
          const epoch = ev.slug?.split('-').pop();
          const time = epoch ? new Date(parseInt(epoch) * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : ev.slug;
          const date = epoch ? new Date(parseInt(epoch) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
          const ourPnl = ev.ours?.pnl;
          const open = expanded[ev.slug];
          const detail = detailCache[ev.slug];
          const feed = detail?.feed || [];
          const ourTrades = feed.filter(t => t.who === 'us');

          return (
            <div key={ev.slug} className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
              <button
                className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-800/50 transition-colors"
                onClick={() => toggleExpand(ev.slug)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-cyan-400 text-xs font-mono">{date} {time}</span>
                  <span className={`text-xs font-bold ${ev.winner === 'Up' ? 'text-green-400' : ev.winner === 'Down' ? 'text-red-400' : 'text-gray-600'}`}>
                    {ev.winner ? `${ev.winner} won` : 'pending'}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-gray-400">spent: <span className="text-white">{usd(ev.ours?.usdc)}</span></span>
                  <span className={ourPnl != null ? (ourPnl >= 0 ? 'text-green-400 font-bold' : 'text-red-400 font-bold') : 'text-gray-500'}>
                    {ourPnl != null ? usd(ourPnl) : '—'}
                  </span>
                  <span className="text-gray-600">{open ? '▲' : '▼'}</span>
                </div>
              </button>

              {open && (
                <div className="px-4 pb-4 border-t border-gray-800">
                  {/* Chart */}
                  <EventChart slug={ev.slug} trades={feed} />

                  {/* Trade list */}
                  <div className="text-xs text-gray-500 mt-3 mb-2">
                    My transactions ({ourTrades.length})
                    {feed.length > ourTrades.length && <span className="text-gray-600"> — k9 had {feed.length - ourTrades.length} trades</span>}
                  </div>
                  {detail?.error ? (
                    <div className="text-red-400 text-xs">{detail.error}</div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto space-y-0.5 font-mono text-xs">
                      {feed.length === 0 && !detail ? (
                        <span className="text-gray-600">Loading…</span>
                      ) : feed.length === 0 ? (
                        <span className="text-gray-600">No trades for this event</span>
                      ) : (
                        feed.map((t, i) => {
                          const timeStr = t.ts ? new Date(t.ts * 1000).toLocaleTimeString('en-US', { hour12: false }) : '';
                          const who = t.who === 'k9' ? 'k9' : 'me';
                          return (
                            <div key={i} className={`flex gap-3 py-0.5 ${who === 'me' ? 'text-gray-300' : 'text-gray-500'}`}>
                              <span className="w-14 text-gray-500">{timeStr}</span>
                              <span className={`w-6 font-bold ${who === 'k9' ? 'text-cyan-400/50' : 'text-orange-400'}`}>{who}</span>
                              <span className={`w-8 font-bold ${t.side === 'buy' ? 'text-cyan-400' : 'text-amber-400'}`}>{t.side === 'buy' ? 'BUY' : 'SELL'}</span>
                              <span className={t.outcome === 'Up' ? 'text-green-400' : 'text-red-400'}>{t.outcome}</span>
                              <span>{t.shares?.toFixed(1)}sh</span>
                              <span>@ {(t.price * 100).toFixed(0)}¢</span>
                              <span className="text-gray-500">{usd(t.usdc)}</span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
