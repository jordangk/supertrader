import React, { useEffect, useState, useRef } from 'react';

const REFRESH_MS = 3000;

function pct(n) { return n.toFixed(1) + '%'; }
function usd(n) { return '$' + n.toFixed(2); }
function price(n) { return n.toFixed(3); }

function SideRow({ side, s, color }) {
  const ratio = s.ratio;
  const ratioColor = ratio < 50 ? 'text-red-400' : ratio > 120 ? 'text-yellow-400' : 'text-green-400';
  return (
    <div className={`grid grid-cols-8 gap-1 text-xs py-1 border-t border-gray-800 ${color}`}>
      <div className="font-bold">{side}</div>
      <div>{usd(s.k9Usdc)}</div>
      <div>{s.k9Shares.toFixed(1)}</div>
      <div>{price(s.k9AvgPrice)}</div>
      <div>{price(s.k9LastPrice)}</div>
      <div>{usd(s.ourUsdc)}</div>
      <div>{usd(s.targetUsdc)}</div>
      <div className={ratioColor}>{pct(ratio)}</div>
    </div>
  );
}

function TradeFeed({ trades }) {
  if (!trades || !trades.length) return <div className="text-gray-600 text-xs py-2">No trades yet</div>;
  return (
    <div className="max-h-40 overflow-y-auto mt-2 space-y-0.5">
      {[...trades].reverse().map((t, i) => {
        const isUp = t.outcome === 'Up';
        const time = t.ts ? new Date(t.ts * 1000).toLocaleTimeString('en-US', { hour12: false }) : '';
        return (
          <div key={i} className="flex gap-2 text-xs font-mono">
            <span className="text-gray-500 w-16">{time}</span>
            <span className={isUp ? 'text-green-400 w-8' : 'text-red-400 w-8'}>{t.outcome}</span>
            <span className="text-gray-300 w-12">{price(t.price)}</span>
            <span className="text-gray-400 w-16">{t.shares.toFixed(1)}sh</span>
            <span className="text-gray-500">{usd(t.usdc)}</span>
          </div>
        );
      })}
    </div>
  );
}

function UDBar({ upUsdc, downUsdc }) {
  const total = upUsdc + downUsdc;
  if (total === 0) return null;
  const upPct = (upUsdc / total) * 100;
  return (
    <div className="mt-2">
      <div className="flex h-3 rounded overflow-hidden">
        <div className="bg-green-600" style={{ width: upPct + '%' }} />
        <div className="bg-red-600" style={{ width: (100 - upPct) + '%' }} />
      </div>
      <div className="flex justify-between text-xs text-gray-500 mt-0.5">
        <span>Up {upPct.toFixed(0)}%</span>
        <span>Down {(100 - upPct).toFixed(0)}%</span>
      </div>
    </div>
  );
}

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function K9Trades() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [lastUpdate, setLastUpdate] = useState(null);
  const [liveCount, setLiveCount] = useState(0);
  const [compareData, setCompareData] = useState(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const ws = useRef(null);

  async function loadCompare() {
    setCompareLoading(true);
    try {
      const r = await fetch(`${API_BASE || ''}/api/k9-compare?slugs=auto`);
      const d = await r.json();
      setCompareData(d.events || []);
    } catch { setCompareData([]); }
    setCompareLoading(false);
  }

  async function load() {
    try {
      const r = await fetch(`${API_BASE}/api/k9-trades?limit=20`);
      const d = await r.json();
      setEvents(d.events || []);
      setLastUpdate(new Date());
    } catch {}
    setLoading(false);
  }

  useEffect(() => {
    load();
    // Poll every 3s for DB-backed summary
    const t = setInterval(load, REFRESH_MS);

    // Also connect WS for live push notifications
    function connectWs() {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.hostname;
      ws.current = new WebSocket(`${protocol}://${host}:3001`);
      ws.current.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'k9_trades') {
            setLiveCount(c => c + msg.trades.length);
            // Reload summary to reflect new trades
            load();
          }
        } catch {}
      };
      ws.current.onclose = () => setTimeout(connectWs, 2000);
      ws.current.onerror = () => ws.current?.close();
    }
    connectWs();

    return () => {
      clearInterval(t);
      ws.current?.close();
    };
  }, []);

  function toggleExpand(slug) {
    setExpanded(p => ({ ...p, [slug]: !p[slug] }));
  }

  if (loading) return (
    <div className="text-gray-500 text-sm p-4">Loading k9 trades…</div>
  );

  if (!events.length) return (
    <div className="text-gray-500 text-sm p-4">No k9 trades recorded yet. Start the monitor script first.</div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-gray-300">k9 Live Trades <span className="text-gray-600 font-normal">(15m)</span></h2>
        <div className="flex items-center gap-3">
          <button
            onClick={loadCompare}
            disabled={compareLoading}
            className="text-xs px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-50"
          >
            {compareLoading ? '…' : 'Compare my copy'}
          </button>
          {lastUpdate && (
            <span className="text-xs text-gray-600">
              updated {lastUpdate.toLocaleTimeString('en-US', { hour12: false })}
            </span>
          )}
          {liveCount > 0 && (
            <span className="text-xs text-orange-400 animate-pulse">
              ● {liveCount} live
            </span>
          )}
        </div>
      </div>

      {compareData && compareData.length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-cyan-800/50 p-4">
          <div className="text-xs font-semibold text-cyan-400 mb-3">k9 vs your copy (events you traded)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-1">Event</th>
                  <th className="text-right py-1">Winner</th>
                  <th className="text-right py-1">k9 $</th>
                  <th className="text-right py-1">k9 PnL</th>
                  <th className="text-right py-1">You $</th>
                  <th className="text-right py-1">You PnL</th>
                  <th className="text-right py-1">%</th>
                </tr>
              </thead>
              <tbody>
                {compareData.map(ev => {
                  const epoch = ev.slug?.split('-').pop();
                  const time = epoch ? new Date(parseInt(epoch) * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : ev.slug;
                  const k9Pnl = ev.k9?.pnl;
                  const ourPnl = ev.ours?.pnl;
                  return (
                    <tr key={ev.slug} className="border-b border-gray-800/50">
                      <td className="py-1.5 text-gray-400 truncate max-w-36">{time}</td>
                      <td className="text-right py-1.5 font-mono">{ev.winner || '—'}</td>
                      <td className="text-right py-1.5">{usd(ev.k9?.usdc || 0)}</td>
                      <td className={`text-right py-1.5 ${k9Pnl != null ? (k9Pnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}`}>
                        {k9Pnl != null ? (k9Pnl >= 0 ? '+' : '') + usd(k9Pnl) : '—'}
                      </td>
                      <td className="text-right py-1.5">{usd(ev.ours?.usdc || 0)}</td>
                      <td className={`text-right py-1.5 ${ourPnl != null ? (ourPnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}`}>
                        {ourPnl != null ? (ourPnl >= 0 ? '+' : '') + usd(ourPnl) : '—'}
                      </td>
                      <td className="text-right py-1.5 text-cyan-400">{ev.ratio != null ? ev.ratio.toFixed(1) + '%' : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-[10px] text-gray-500">
            % = your size as % of k9&apos;s. PnL at resolution.
          </div>
        </div>
      )}

      {events.map(ev => {
        const { slug, summary, recent, totalTrades } = ev;
        const up = summary?.Up || {};
        const dn = summary?.Down || {};
        const totalK9 = (up.k9Usdc || 0) + (dn.k9Usdc || 0);
        const totalOurs = (up.ourUsdc || 0) + (dn.ourUsdc || 0);
        const totalTarget = totalK9 * 0.01;
        const overallRatio = totalK9 > 0 ? (totalOurs / totalK9) * 100 : 0;

        // epoch from slug
        const epoch = slug.split('-').pop();
        let timeLabel = epoch;
        try { timeLabel = new Date(parseInt(epoch) * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch {}

        const ratioColor = overallRatio < 40 ? 'text-red-400' : overallRatio > 150 ? 'text-yellow-400' : 'text-green-400';
        const open = expanded[slug];

        return (
          <div key={slug} className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
            {/* Header row */}
            <button
              className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-800 transition-colors"
              onClick={() => toggleExpand(slug)}
            >
              <div className="flex items-center gap-3">
                <span className="text-orange-400 text-xs font-mono">{timeLabel}</span>
                <span className="text-gray-400 text-xs font-mono truncate max-w-48">{slug}</span>
                <span className="text-gray-600 text-xs">{totalTrades} trades</span>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <span className="text-gray-400">k9: <span className="text-white">{usd(totalK9)}</span></span>
                <span className="text-gray-400">us: <span className="text-white">{usd(totalOurs)}</span></span>
                <span className="text-gray-400">target: <span className="text-white">{usd(totalTarget)}</span></span>
                <span className={`font-bold ${ratioColor}`}>{pct(overallRatio)}</span>
                <span className="text-gray-600">{open ? '▲' : '▼'}</span>
              </div>
            </button>

            {open && (
              <div className="px-4 pb-4">
                {/* Up/Down bar */}
                <UDBar upUsdc={up.k9Usdc || 0} downUsdc={dn.k9Usdc || 0} />

                {/* Side breakdown table */}
                <div className="mt-3">
                  {/* Header */}
                  <div className="grid grid-cols-8 gap-1 text-xs text-gray-600 pb-1">
                    <div>Side</div>
                    <div>k9 USDC</div>
                    <div>k9 Sh</div>
                    <div>k9 Avg</div>
                    <div>Last</div>
                    <div>Our USDC</div>
                    <div>Target</div>
                    <div>Ratio</div>
                  </div>
                  <SideRow side="Up"   s={up} color="text-green-300" />
                  <SideRow side="Down" s={dn} color="text-red-300" />
                </div>

                {/* Recent trade feed */}
                <div className="mt-3">
                  <div className="text-xs text-gray-600 mb-1">Recent trades (last 30)</div>
                  <TradeFeed trades={recent} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
