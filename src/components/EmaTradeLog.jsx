import React, { useEffect, useState } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function EmaTradeLog() {
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // 'all' | 'profit' | 'loss'
  const [sourceFilter, setSourceFilter] = useState('all'); // 'all' | 'ema' | 'scalp' | 'flow'
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    const fetchData = () =>
      fetch(`${API_BASE}/api/ema-trades?limit=100`)
        .then(r => r.json())
        .then(d => setCycles(d.cycles || []))
        .catch(() => setCycles([]))
        .finally(() => setLoading(false));
    fetchData();
    const iv = setInterval(fetchData, 15000);
    return () => clearInterval(iv);
  }, []);

  const filtered = cycles.filter(c => {
    if (filter === 'profit') return c.profitCents > 0;
    if (filter === 'loss') return c.profitCents <= 0;
    if (sourceFilter !== 'all' && c.source !== sourceFilter) return false;
    return true;
  });

  const totalProfit = filtered.reduce((s, c) => s + c.profitCents, 0);
  const profitableCount = filtered.filter(c => c.profitCents > 0).length;

  function formatTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  if (loading) return <div className="text-gray-500 text-sm py-8">Loading trade log…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-bold text-gray-200">Hedged Trades Log</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Filter:</span>
          {[['all', 'All'], ['profit', 'Profitable'], ['loss', 'Loss / BE']].map(([v, label]) => (
            <button key={v} onClick={() => setFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium ${filter === v ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
              {label}
            </button>
          ))}
          <span className="text-xs text-gray-500 ml-2">Type:</span>
          {[['all', 'All'], ['ema', 'EMA'], ['scalp', 'Scalp'], ['flow', 'Flow']].map(([v, label]) => (
            <button key={v} onClick={() => setSourceFilter(v)}
              className={`px-3 py-1 rounded text-xs font-medium ${sourceFilter === v ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-4 text-sm font-mono mb-4">
        <span className={totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}>
          Total: {totalProfit >= 0 ? '+' : ''}{totalProfit}¢
        </span>
        <span className="text-gray-500">Profitable: {profitableCount}/{filtered.length}</span>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
        <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-900 border-b border-gray-800">
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider">
                <th className="text-left py-2 px-3">Time</th>
                <th className="text-left py-2 px-3">Type</th>
                <th className="text-left py-2 px-3">Event</th>
                <th className="text-left py-2 px-3">Side</th>
                <th className="text-right py-2 px-3">Up Paid</th>
                <th className="text-right py-2 px-3">Down Paid</th>
                <th className="text-right py-2 px-3">Total</th>
                <th className="text-right py-2 px-3">Profit</th>
                <th className="text-left py-2 px-3">Gap / MACD</th>
                <th className="text-left py-2 px-3">Exit</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <React.Fragment key={c.id || i}>
                  <tr className={`border-b border-gray-800/50 hover:bg-gray-800/30 ${c.profitCents > 0 ? 'text-green-400/90' : c.profitCents < 0 ? 'text-red-400/90' : 'text-gray-400'}`}>
                    <td className="py-2 px-3 font-mono whitespace-nowrap">{formatTime(c.entryTime)}</td>
                    <td className="py-2 px-3"><span className="text-[10px] uppercase">{c.source || 'ema'}</span></td>
                    <td className="py-2 px-3 text-gray-400 truncate max-w-[120px]" title={c.eventSlug}>{c.eventSlug?.slice(-20) || c.polymarketEventId}</td>
                    <td className="py-2 px-3">
                      <span className={c.entrySide === 'up' ? 'text-green-400' : 'text-red-400'}>{c.entrySide?.toUpperCase()}</span>
                    </td>
                    <td className="py-2 px-3 text-right font-mono">{c.upPaidCents}¢</td>
                    <td className="py-2 px-3 text-right font-mono">{c.downPaidCents}¢</td>
                    <td className="py-2 px-3 text-right font-mono">{c.upPaidCents + c.downPaidCents}¢</td>
                    <td className="py-2 px-3 text-right font-bold">
                      {c.profitCents >= 0 ? '+' : ''}{c.profitCents}¢
                    </td>
                    <td className="py-2 px-3 text-gray-500 font-mono">
                      {c.gap != null ? `$${c.gap}` : '—'}
                      {c.histogram != null && ` / ${c.histogram}`}
                    </td>
                    <td className="py-2 px-3 text-gray-500">{c.hedgeReason?.replace('_', ' ') || '—'}</td>
                    <td className="py-2 px-3">
                      <button onClick={() => setExpanded(prev => ({ ...prev, [c.id || i]: !prev[c.id || i] }))}
                        className="text-gray-500 hover:text-gray-300">▸</button>
                    </td>
                  </tr>
                  {expanded[c.id || i] && (
                    <tr className="bg-gray-950/50 border-b border-gray-800/50">
                      <td colSpan={11} className="py-2 px-3 text-[11px] text-gray-500 space-y-1">
                        <div>Entry: {c.entrySide?.toUpperCase()} @ {c.entryPriceCents}¢ → Hedge: {c.entrySide === 'up' ? 'DOWN' : 'UP'} @ {c.hedgePriceCents}¢</div>
                        <div>Gap: ${c.gap ?? '—'} | Peak: ${c.peakGap ?? '—'} | MACD Histogram: {c.histogram ?? '—'}</div>
                        <div>EMA 12: {c.e12 ?? '—'} | EMA 26: {c.e26 ?? '—'} | BTC: ${c.btcAtEntry ?? '—'} | {c.shares} shares</div>
                      </td>
                  </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="py-12 text-center text-gray-500">No hedged trades yet (EMA, Scalp, Flow)</div>
        )}
      </div>
    </div>
  );
}
