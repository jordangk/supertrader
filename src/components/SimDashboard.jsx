import React, { useEffect, useState, useRef } from 'react';

const REFRESH_MS = 3000;
const COPY_PCT   = 0.01;
const API_BASE   = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function usd(n)   { return '$' + (n||0).toFixed(2); }
function pri(n)   { return ((n||0) * 100).toFixed(1) + '¢'; }
function pct(n)   { return (n||0).toFixed(1) + '%'; }

function UDBar({ up, down }) {
  const total = up + down;
  if (!total) return null;
  const upPct = (up / total) * 100;
  return (
    <div className="flex h-2 rounded overflow-hidden mt-1">
      <div className="bg-green-500" style={{ width: upPct + '%' }} />
      <div className="bg-red-500"   style={{ width: (100 - upPct) + '%' }} />
    </div>
  );
}

function SummaryCard({ totals }) {
  if (!totals?.tradeCount) return null;
  return (
    <div className="grid grid-cols-4 gap-3 mb-4">
      {[
        { label: 'Events',       val: totals.eventCount },
        { label: 'Sim Trades',   val: totals.tradeCount },
        { label: 'Sim Spent',    val: usd(totals.totalSimUsdc) },
        { label: 'k9 Spent',     val: usd(totals.totalK9Usdc) },
      ].map(({ label, val }) => (
        <div key={label} className="bg-gray-900 rounded-lg p-3 border border-gray-800">
          <div className="text-xs text-gray-500">{label}</div>
          <div className="text-lg font-bold text-white mt-0.5">{val}</div>
        </div>
      ))}
    </div>
  );
}

function EventCard({ ev }) {
  const [open, setOpen] = useState(false);
  const { slug, summary, feed, totalSimUsdc, totalK9Usdc } = ev;
  const up = summary?.Up || {};
  const dn = summary?.Down || {};

  const epoch = slug.split('-').pop();
  let timeLabel = epoch;
  try { timeLabel = new Date(parseInt(epoch)*1000).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}); } catch {}

  const upPct  = totalK9Usdc > 0 ? (up.k9Usdc / totalK9Usdc * 100) : 0;
  const dnPct  = totalK9Usdc > 0 ? (dn.k9Usdc / totalK9Usdc * 100) : 0;

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      <button className="w-full text-left px-4 py-3 hover:bg-gray-800 transition-colors"
        onClick={() => setOpen(o => !o)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-orange-400 text-xs font-mono">{timeLabel}</span>
            <span className="text-gray-500 text-xs font-mono truncate max-w-56">{slug}</span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="text-gray-400">k9: <span className="text-white font-medium">{usd(totalK9Usdc)}</span></span>
            <span className="text-gray-400">sim: <span className="text-green-400 font-medium">{usd(totalSimUsdc)}</span></span>
            <span className="text-gray-400">{(ev.feed||[]).length} trades</span>
            <span className="text-gray-600">{open ? '▲' : '▼'}</span>
          </div>
        </div>
        <UDBar up={up.k9Usdc||0} down={dn.k9Usdc||0} />
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-800">
          {/* Side table */}
          <div className="mt-3">
            <div className="grid grid-cols-6 gap-2 text-xs text-gray-600 pb-1">
              <div>Side</div><div>k9 USDC</div><div>k9 Avg</div>
              <div>Sim USDC</div><div>Sim Sh</div><div>Sim Avg</div>
            </div>
            {['Up','Down'].map(side => {
              const s = summary[side] || {};
              const color = side === 'Up' ? 'text-green-300' : 'text-red-300';
              return (
                <div key={side} className={`grid grid-cols-6 gap-2 text-xs py-1.5 border-t border-gray-800 ${color}`}>
                  <div className="font-bold">{side}</div>
                  <div>{usd(s.k9Usdc)}</div>
                  <div>{pri(s.k9AvgPrice)}</div>
                  <div className="text-white">{usd(s.simUsdc)}</div>
                  <div className="text-white">{(s.simShares||0).toFixed(1)}</div>
                  <div className="text-white">{pri(s.simAvgPrice)}</div>
                </div>
              );
            })}
          </div>

          {/* Trade feed — sim fills only (carry-over resolved) */}
          <div className="mt-4">
            <div className="text-xs text-gray-600 mb-2">
              Sim fills <span className="text-gray-700">(carry-over → $1 min order)</span>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {[...(feed||[])].reverse().map((t, i) => {
                const isUp = t.outcome === 'Up';
                const time = t.ts ? new Date(t.ts*1000).toLocaleTimeString('en-US',{hour12:false}) : '';
                return (
                  <div key={i} className="flex gap-3 text-xs font-mono items-center py-0.5 border-b border-gray-800/50">
                    <span className="text-gray-600 w-16">{time}</span>
                    <span className={`w-8 font-medium ${isUp ? 'text-green-400' : 'text-red-400'}`}>{t.outcome}</span>
                    <span className="text-gray-500 w-10">{pri(t.k9Price)}</span>
                    <span className="text-gray-600 w-18">k9 {usd(t.k9Usdc)}</span>
                    <span className="text-orange-400 w-4">→</span>
                    <span className="text-white font-medium">{usd(t.simUsdc)}</span>
                    <span className="text-gray-500">@ {pri(t.simPrice)}</span>
                    <span className="text-gray-600">{t.simShares.toFixed(2)}sh</span>
                  </div>
                );
              })}
              {!(feed||[]).length && (
                <div className="text-gray-600 py-2">No fills yet — accumulating carry-over…</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SimDashboard() {
  const [data, setData]       = useState({ events: [], totals: {} });
  const [loading, setLoading] = useState(true);
  const [liveFlash, setFlash] = useState(false);
  const ws = useRef(null);

  async function load() {
    try {
      const r = await fetch(`${API_BASE}/api/sim-dashboard?limit=10`);
      const d = await r.json();
      setData(d);
    } catch {}
    setLoading(false);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);

    function connectWs() {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws.current = new WebSocket(`${proto}://${window.location.hostname}:3001`);
      ws.current.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'k9_trades') {
            setFlash(true);
            setTimeout(() => setFlash(false), 1000);
            load();
          }
        } catch {}
      };
      ws.current.onclose = () => setTimeout(connectWs, 2000);
      ws.current.onerror = () => ws.current?.close();
    }
    connectWs();
    return () => { clearInterval(t); ws.current?.close(); };
  }, []);

  if (loading) return <div className="text-gray-500 text-sm p-4">Loading simulation…</div>;

  const { events, totals } = data;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-300">Sim Dashboard
            <span className="text-gray-600 font-normal ml-2">— {COPY_PCT*100}% copy of k9</span>
          </h2>
          <p className="text-xs text-gray-600 mt-0.5">What we would have traded if the bot was running</p>
        </div>
        {liveFlash && (
          <span className="text-xs text-orange-400 animate-pulse font-medium">● new trade</span>
        )}
      </div>

      <SummaryCard totals={totals} />

      {!events?.length ? (
        <div className="text-gray-600 text-sm bg-gray-900 rounded-lg p-6 text-center border border-gray-800">
          No simulated trades yet — waiting for k9 to trade…
        </div>
      ) : (
        events.map(ev => <EventCard key={ev.slug} ev={ev} />)
      )}
    </div>
  );
}
