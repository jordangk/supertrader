import React, { useEffect, useState, useRef } from 'react';

const REFRESH_MS = 3000;
const PCT_OPTIONS = [0.5, 1, 2, 5, 10];
const API_BASE   = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function usd(n)   { return '$' + (n||0).toFixed(2); }
function pri(n)   { return ((n||0) * 100).toFixed(1) + '\u00A2'; }

function parseSlug(slug) {
  const parts = slug.split('-');
  const epoch = parseInt(parts[parts.length - 1]);
  const tf = parts[parts.length - 2];
  const date = new Date(epoch * 1000);
  return {
    timeframe: tf,
    epoch,
    timeLabel: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
    dateLabel: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  };
}

/* ── Shared: Up/Down allocation bar ─────────────────────────────── */
function UDBar({ up, down }) {
  const total = up + down;
  if (!total) return null;
  const upPct = (up / total) * 100;
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden">
      <div className="bg-green-500" style={{ width: upPct + '%' }} />
      <div className="bg-red-500"   style={{ width: (100 - upPct) + '%' }} />
    </div>
  );
}

/* ── Totals bar ─────────────────────────────────────────────────── */
function TotalsBar({ totals, events }) {
  if (!totals?.tradeCount) return null;
  const ratio = totals.totalK9Usdc > 0
    ? (totals.totalSimUsdc / totals.totalK9Usdc * 100).toFixed(1) + '%'
    : '--';

  // Sum actual P&L across all resolved events
  let simTotalPnl = 0;
  let k9TotalPnl = 0;
  let resolvedCount = 0;
  (events || []).forEach(ev => {
    const r = ev.resolution;
    if (!r?.closed || !r?.winner) return;
    resolvedCount++;
    const up = ev.summary?.Up || {};
    const dn = ev.summary?.Down || {};
    for (const [side, d] of [['Up', up], ['Down', dn]]) {
      const won = r.winner === side;
      simTotalPnl += (won ? (d.simShares || 0) : 0) - (d.simUsdc || 0);
      k9TotalPnl  += (won ? (d.k9Shares || 0) : 0)  - (d.k9Usdc || 0);
    }
  });

  const cards = [
    { label: 'Events',     val: totals.eventCount, sub: resolvedCount > 0 ? `${resolvedCount} resolved` : null },
    { label: 'Sim Trades', val: totals.tradeCount },
    { label: 'Sim Spent',  val: usd(totals.totalSimUsdc) },
    { label: 'k9 Spent',   val: usd(totals.totalK9Usdc), sub: ratio + ' ratio' },
  ];

  return (
    <div className="space-y-3 mb-4">
      <div className="grid grid-cols-4 gap-3">
        {cards.map(({ label, val, sub }) => (
          <div key={label} className="bg-gray-900 rounded-xl p-3 border border-gray-800">
            <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
            <div className="text-lg font-bold font-mono text-white mt-0.5">{val}</div>
            {sub && <div className="text-[10px] text-orange-400 mt-0.5">{sub}</div>}
          </div>
        ))}
      </div>
      {resolvedCount > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className={`rounded-xl p-3 border ${k9TotalPnl >= 0 ? 'bg-green-950/30 border-green-900/50' : 'bg-red-950/30 border-red-900/50'}`}>
            <div className="text-[10px] uppercase tracking-wider text-gray-500">k9 P&L ({resolvedCount} events)</div>
            <div className={`text-lg font-bold font-mono mt-0.5 ${k9TotalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {k9TotalPnl >= 0 ? '+' : ''}{usd(k9TotalPnl)}
            </div>
          </div>
          <div className={`rounded-xl p-3 border ${simTotalPnl >= 0 ? 'bg-green-950/30 border-green-900/50' : 'bg-red-950/30 border-red-900/50'}`}>
            <div className="text-[10px] uppercase tracking-wider text-gray-500">Sim P&L ({resolvedCount} events)</div>
            <div className={`text-lg font-bold font-mono mt-0.5 ${simTotalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {simTotalPnl >= 0 ? '+' : ''}{usd(simTotalPnl)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Winner badge helper ───────────────────────────────────────── */
function WinnerBadge({ resolution }) {
  if (!resolution?.closed || !resolution?.winner) return null;
  const isUp = resolution.winner === 'Up';
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
      isUp ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
    }`}>
      {resolution.winner} won
    </span>
  );
}

/* ── Compute actual P&L for a side given resolution ────────────── */
function computePnl(shares, cost, side, resolution) {
  if (!resolution?.closed || !resolution?.winner) return null;
  const won = resolution.winner === side;
  const payout = won ? (shares || 0) : 0; // $1/share if won, $0 if lost
  const pnl = payout - (cost || 0);
  const pct = cost > 0 ? (pnl / cost * 100) : 0;
  return { won, payout, pnl, pct };
}

/* ── Event row (list view) ──────────────────────────────────────── */
function EventRow({ ev, onClick }) {
  const { slug, summary, totalSimUsdc, totalK9Usdc, resolution } = ev;
  const up = summary?.Up || {};
  const dn = summary?.Down || {};
  const parsed = parseSlug(slug);
  const tradeCount = (up.tradeCount || 0) + (dn.tradeCount || 0);

  // Compute actual P&L for sim if resolved
  let simPnl = null;
  if (resolution?.closed && resolution?.winner) {
    const upR = computePnl(up.simShares, up.simUsdc, 'Up', resolution);
    const dnR = computePnl(dn.simShares, dn.simUsdc, 'Down', resolution);
    simPnl = (upR?.pnl || 0) + (dnR?.pnl || 0);
  }

  return (
    <button
      className="w-full text-left bg-gray-900 rounded-xl border border-gray-800 p-4 hover:border-gray-700 hover:bg-gray-800/50 cursor-pointer transition-all"
      onClick={() => onClick(slug)}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-orange-400 text-sm font-mono font-bold">{parsed.timeLabel}</span>
          <span className="bg-gray-800 text-gray-400 text-[10px] px-1.5 py-0.5 rounded font-mono">{parsed.timeframe}</span>
          <span className="text-gray-500 text-xs">{parsed.dateLabel}</span>
          <WinnerBadge resolution={resolution} />
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`https://polymarket.com/event/${slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-400/50 hover:text-blue-300 transition-colors"
            onClick={e => e.stopPropagation()}
          >
            &#8599;
          </a>
          <span className="text-gray-600 text-sm">&rsaquo;</span>
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs font-mono mb-2">
        <span className="text-gray-500">k9: <span className="text-white font-medium">{usd(totalK9Usdc)}</span></span>
        <span className="text-gray-500">sim: <span className="text-orange-400 font-medium">{usd(totalSimUsdc)}</span></span>
        <span className="text-gray-500">{tradeCount} fills</span>
        {simPnl !== null && (
          <span className={`font-bold ${simPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {simPnl >= 0 ? '+' : ''}{usd(simPnl)}
          </span>
        )}
      </div>
      <UDBar up={up.k9Usdc||0} down={dn.k9Usdc||0} />
      <div className="flex gap-3 text-[10px] text-gray-600 mt-1">
        <span>Up {totalK9Usdc > 0 ? ((up.k9Usdc||0) / totalK9Usdc * 100).toFixed(0) : 0}%</span>
        <span>Down {totalK9Usdc > 0 ? ((dn.k9Usdc||0) / totalK9Usdc * 100).toFixed(0) : 0}%</span>
      </div>
    </button>
  );
}

/* ── Position card (Polymarket-style) ───────────────────────────── */
function PositionCard({ label, side, avgPrice, shares, cost, resolution }) {
  const maxPayout  = shares || 0;
  const potentialPnl = maxPayout - (cost || 0);
  const potentialPct = cost > 0 ? (potentialPnl / cost * 100) : 0;
  const sideColor  = side === 'Up' ? 'text-green-400' : 'text-red-400';
  const sideBg     = side === 'Up' ? 'bg-green-500/10' : 'bg-red-500/10';

  const result = computePnl(shares, cost, side, resolution);

  return (
    <div className={`bg-gray-900 rounded-xl border p-4 ${
      result ? (result.won ? 'border-green-800' : 'border-red-900/50') : 'border-gray-800'
    }`}>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">{label}</span>
        {result && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            result.won ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {result.won ? 'WON' : 'LOST'}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between">
        {/* Left: side badge + shares */}
        <div className="flex items-center gap-3">
          <span className={`${sideBg} ${sideColor} text-xs font-bold px-2 py-0.5 rounded`}>
            {side} {pri(avgPrice)}
          </span>
          <span className="text-gray-400 text-xs font-mono">
            {(shares||0).toLocaleString('en-US', { maximumFractionDigits: 1 })} shares
          </span>
        </div>
        {/* Center: avg price → payout */}
        <div className="flex items-center gap-6 text-xs font-mono">
          <span className="text-gray-400">{pri(avgPrice)}</span>
          <span className="text-gray-500">{result ? (result.won ? '100¢' : '0¢') : '100¢'}</span>
        </div>
        {/* Right: cost + P&L */}
        <div className="text-right">
          <div className="text-white font-bold font-mono text-sm">{usd(cost)}</div>
          {result ? (
            <div className={`text-xs font-mono font-bold ${result.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {result.pnl >= 0 ? '+' : ''}{usd(result.pnl)} ({result.pct.toFixed(0)}%)
            </div>
          ) : (
            <div className="text-xs font-mono text-green-400/60">
              +{usd(potentialPnl)} ({potentialPct.toFixed(0)}%) if win
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Detail view ────────────────────────────────────────────────── */
function DetailView({ event, onBack, copyPct }) {
  const { slug, summary, feed, totalSimUsdc, totalK9Usdc, resolution } = event;
  const parsed = parseSlug(slug);
  const up = summary?.Up || {};
  const dn = summary?.Down || {};

  // Actual P&L for resolved events
  const k9UpPnl  = computePnl(up.k9Shares,  up.k9Usdc,  'Up',   resolution);
  const k9DnPnl  = computePnl(dn.k9Shares,  dn.k9Usdc,  'Down', resolution);
  const simUpPnl = computePnl(up.simShares,  up.simUsdc,  'Up',   resolution);
  const simDnPnl = computePnl(dn.simShares,  dn.simUsdc,  'Down', resolution);

  const k9TotalPnl  = k9UpPnl && k9DnPnl ? (k9UpPnl.pnl + k9DnPnl.pnl) : null;
  const simTotalPnl = simUpPnl && simDnPnl ? (simUpPnl.pnl + simDnPnl.pnl) : null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-orange-400 hover:text-orange-300 transition-colors mb-3">
          &#8592; Back to events
        </button>
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold font-mono text-white">{parsed.timeLabel}</span>
          <span className="bg-gray-800 text-gray-400 text-xs px-2 py-1 rounded font-mono">{parsed.timeframe}</span>
          <span className="text-gray-500 text-sm">{parsed.dateLabel}</span>
          <WinnerBadge resolution={resolution} />
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-gray-600 font-mono">{slug}</span>
          <a
            href={`https://polymarket.com/event/${slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            onClick={e => e.stopPropagation()}
          >
            Polymarket &#8599;
          </a>
        </div>
      </div>

      {/* k9 positions */}
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-2 px-1">k9 Positions</div>
        <div className="space-y-2">
          {up.k9Shares > 0 && (
            <PositionCard label="k9" side="Up" avgPrice={up.k9AvgPrice} shares={up.k9Shares} cost={up.k9Usdc} resolution={resolution} />
          )}
          {dn.k9Shares > 0 && (
            <PositionCard label="k9" side="Down" avgPrice={dn.k9AvgPrice} shares={dn.k9Shares} cost={dn.k9Usdc} resolution={resolution} />
          )}
          {!up.k9Shares && !dn.k9Shares && (
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-gray-600 text-sm text-center">No k9 positions</div>
          )}
        </div>
      </div>

      {/* Sim positions */}
      <div>
        <div className="text-xs text-orange-400/70 uppercase tracking-wider font-bold mb-2 px-1">Sim Positions ({copyPct}% copy)</div>
        <div className="space-y-2">
          {up.simShares > 0 && (
            <PositionCard label="Sim" side="Up" avgPrice={up.simAvgPrice} shares={up.simShares} cost={up.simUsdc} resolution={resolution} />
          )}
          {dn.simShares > 0 && (
            <PositionCard label="Sim" side="Down" avgPrice={dn.simAvgPrice} shares={dn.simShares} cost={dn.simUsdc} resolution={resolution} />
          )}
          {!up.simShares && !dn.simShares && (
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-gray-600 text-sm text-center">No sim positions</div>
          )}
        </div>
      </div>

      {/* Summary comparison */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-3">
          {resolution?.closed && resolution?.winner ? 'Results' : 'Summary'}
        </div>
        {resolution?.closed && resolution?.winner ? (
          /* Resolved: show actual P&L */
          <div className="grid grid-cols-3 gap-4 text-xs">
            <div>
              <div className="text-gray-500 mb-1">Total Spent</div>
              <div className="font-mono text-white">{usd(totalK9Usdc)} <span className="text-gray-600">k9</span></div>
              <div className="font-mono text-orange-400">{usd(totalSimUsdc)} <span className="text-gray-600">sim</span></div>
            </div>
            <div>
              <div className="text-gray-500 mb-1">Payout</div>
              <div className="font-mono text-white">{usd((k9UpPnl?.payout||0) + (k9DnPnl?.payout||0))} <span className="text-gray-600">k9</span></div>
              <div className="font-mono text-orange-400">{usd((simUpPnl?.payout||0) + (simDnPnl?.payout||0))} <span className="text-gray-600">sim</span></div>
            </div>
            <div>
              <div className="text-gray-500 mb-1">P&L</div>
              <div className={`font-mono font-bold ${k9TotalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {k9TotalPnl >= 0 ? '+' : ''}{usd(k9TotalPnl)} <span className="text-gray-600 font-normal">k9</span>
              </div>
              <div className={`font-mono font-bold ${simTotalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {simTotalPnl >= 0 ? '+' : ''}{usd(simTotalPnl)} <span className="text-gray-600 font-normal">sim</span>
              </div>
            </div>
          </div>
        ) : (
          /* Unresolved: show hypothetical */
          <div className="grid grid-cols-3 gap-4 text-xs">
            <div>
              <div className="text-gray-500 mb-1">Total Spent</div>
              <div className="font-mono text-white">{usd(totalK9Usdc)} <span className="text-gray-600">k9</span></div>
              <div className="font-mono text-orange-400">{usd(totalSimUsdc)} <span className="text-gray-600">sim</span></div>
            </div>
            <div>
              <div className="text-gray-500 mb-1">If Up Wins</div>
              <div className="font-mono text-white">{usd(up.k9Shares||0)} <span className="text-gray-600">k9</span></div>
              <div className="font-mono text-orange-400">{usd(up.simShares||0)} <span className="text-gray-600">sim</span></div>
            </div>
            <div>
              <div className="text-gray-500 mb-1">If Down Wins</div>
              <div className="font-mono text-white">{usd(dn.k9Shares||0)} <span className="text-gray-600">k9</span></div>
              <div className="font-mono text-orange-400">{usd(dn.simShares||0)} <span className="text-gray-600">sim</span></div>
            </div>
          </div>
        )}
      </div>

      {/* Trade feed */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <span className="text-sm font-semibold text-gray-300">Trade Feed</span>
          <span className="text-xs text-gray-600">{(feed||[]).length} fills</span>
        </div>
        <div className="px-4">
          <div className="grid grid-cols-7 gap-2 text-[10px] text-gray-600 uppercase tracking-wider py-2 border-b border-gray-800">
            <div>Time</div><div>Side</div><div>k9 Price</div><div>k9 USDC</div>
            <div className="text-center"></div><div>Sim USDC</div><div>Sim Sh</div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {[...(feed||[])].reverse().map((t, i) => {
              const isUp = t.outcome === 'Up';
              const time = t.ts ? new Date(t.ts * 1000).toLocaleTimeString('en-US', { hour12: false }) : '';
              return (
                <div key={i} className="grid grid-cols-7 gap-2 text-xs font-mono py-1.5 border-b border-gray-800/50 items-center">
                  <span className="text-gray-500">{time}</span>
                  <span className={`font-bold ${isUp ? 'text-green-400' : 'text-red-400'}`}>{t.outcome}</span>
                  <span className="text-gray-400">{pri(t.k9Price)}</span>
                  <span className="text-gray-400">{usd(t.k9Usdc)}</span>
                  <span className="text-orange-400 text-center">&rarr;</span>
                  <span className="text-white font-medium">{usd(t.simUsdc)}</span>
                  <span className="text-gray-400">{(t.simShares||0).toFixed(2)}</span>
                </div>
              );
            })}
            {!(feed||[]).length && (
              <div className="text-gray-600 text-sm py-4 text-center">No fills yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Root component ─────────────────────────────────────────────── */
export default function SimDashboard() {
  const [data, setData]             = useState({ events: [], totals: {} });
  const [loading, setLoading]       = useState(true);
  const [liveFlash, setFlash]       = useState(false);
  const [view, setView]             = useState('list');
  const [selectedSlug, setSelected] = useState(null);
  const [search, setSearch]         = useState('');
  const [copyPct, setCopyPct]       = useState(1);
  const ws = useRef(null);

  async function load(pct) {
    try {
      const r = await fetch(`${API_BASE}/api/sim-dashboard?limit=50&pct=${pct ?? copyPct}`);
      const d = await r.json();
      setData(d);
    } catch {}
    setLoading(false);
  }

  useEffect(() => {
    load(copyPct);
    const t = setInterval(() => load(copyPct), REFRESH_MS);

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
  }, [copyPct]);

  function openDetail(slug) {
    setSelected(slug);
    setView('detail');
  }
  function goBack() {
    setView('list');
    setSelected(null);
  }

  const { events, totals } = data;
  const selectedEvent = events.find(ev => ev.slug === selectedSlug);

  const filtered = events.filter(ev => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const p = parseSlug(ev.slug);
    return ev.slug.toLowerCase().includes(q) ||
      p.timeLabel.includes(q) ||
      p.dateLabel.toLowerCase().includes(q);
  });

  if (loading) {
    return (
      <div className="space-y-3">
        {[1,2,3].map(i => (
          <div key={i} className="bg-gray-900 rounded-xl border border-gray-800 p-4 animate-pulse">
            <div className="h-4 bg-gray-800 rounded w-1/3 mb-3" />
            <div className="h-3 bg-gray-800 rounded w-2/3 mb-2" />
            <div className="h-1.5 bg-gray-800 rounded w-full" />
          </div>
        ))}
      </div>
    );
  }

  const pctSelector = (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-gray-500">Copy %</span>
      <div className="flex bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        {PCT_OPTIONS.map(p => (
          <button
            key={p}
            onClick={() => setCopyPct(p)}
            className={`px-2 py-1 text-xs font-mono transition-colors ${
              copyPct === p
                ? 'bg-orange-500 text-white font-bold'
                : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            {p}%
          </button>
        ))}
      </div>
    </div>
  );

  /* Detail view */
  if (view === 'detail' && selectedEvent) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <TotalsBar totals={totals} events={events} />
          {pctSelector}
        </div>
        <DetailView event={selectedEvent} onBack={goBack} copyPct={copyPct} />
      </div>
    );
  }

  /* List view */
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-300">
            Sim Dashboard
            <span className="text-gray-600 font-normal ml-2">-- {copyPct}% copy of k9</span>
          </h2>
          <p className="text-xs text-gray-600 mt-0.5">Click an event to compare k9 vs sim</p>
        </div>
        <div className="flex items-center gap-3">
          {liveFlash && (
            <span className="text-xs text-orange-400 animate-pulse font-medium">* new trade</span>
          )}
          {pctSelector}
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search events..."
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500 w-44"
          />
        </div>
      </div>

      <TotalsBar totals={totals} events={events} />

      {!filtered.length ? (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 text-center">
          <p className="text-gray-500 text-sm">
            {search ? `No events matching "${search}"` : 'No simulated trades yet -- waiting for k9 to trade...'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(ev => (
            <EventRow key={ev.slug} ev={ev} onClick={openDetail} />
          ))}
        </div>
      )}
    </div>
  );
}
