import React, { useEffect, useState } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function usd(n) {
  const x = parseFloat(n);
  if (isNaN(x)) return '—';
  return '$' + (x >= 0 ? '+' : '') + x.toFixed(2);
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
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (loading) return (
    <div className="text-gray-500 text-sm p-4">Loading your trades…</div>
  );

  if (!events.length) return (
    <div className="text-gray-500 text-sm p-4">No trades found. Your trades appear here with k9&apos;s performance on the same events.</div>
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-300">My Trades</h2>
        <p className="text-xs text-gray-500 mt-0.5">Events you traded. Click a row to see all transactions (his and yours) for that event.</p>
      </div>

      <div className="space-y-1">
        {events.map(ev => {
          const epoch = ev.slug?.split('-').pop();
          const time = epoch ? new Date(parseInt(epoch) * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : ev.slug;
          const k9Pnl = ev.k9?.pnl;
          const ourPnl = ev.ours?.pnl;
          const open = expanded[ev.slug];
          const detail = detailCache[ev.slug];
          const feed = detail?.feed || [];

          return (
            <div key={ev.slug} className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
              <button
                className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-800/50 transition-colors"
                onClick={() => toggleExpand(ev.slug)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-cyan-400 text-xs font-mono">{time}</span>
                  <span className="text-gray-500 text-xs">{ev.slug}</span>
                  <span className="text-gray-600 text-xs">{ev.winner || '—'} won</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-gray-400">me: <span className="text-white">{usd(ev.ours?.usdc)}</span></span>
                  <span className={ourPnl != null ? (ourPnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}>
                    {ourPnl != null ? usd(ourPnl) : '—'}
                  </span>
                  <span className="text-gray-400">k9: <span className="text-white">{usd(ev.k9?.usdc)}</span></span>
                  <span className={k9Pnl != null ? (k9Pnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}>
                    {k9Pnl != null ? usd(k9Pnl) : '—'}
                  </span>
                  <span className="text-cyan-400">{ev.ratio != null ? ev.ratio.toFixed(1) + '%' : '—'}</span>
                  <span className="text-gray-600">{open ? '▲' : '▼'}</span>
                </div>
              </button>

              {open && (
                <div className="px-4 pb-4 border-t border-gray-800">
                  <div className="text-xs text-gray-500 mt-3 mb-2">All transactions ({feed.length}) — k9 & you</div>
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
                            <div key={i} className="flex gap-3 text-gray-400 py-0.5">
                              <span className="w-14 text-gray-500">{timeStr}</span>
                              <span className={`w-6 font-bold ${who === 'k9' ? 'text-cyan-400' : 'text-orange-400'}`}>{who}</span>
                              <span className="w-8 font-bold">{t.side === 'buy' ? 'BUY' : 'SELL'}</span>
                              <span className={t.outcome === 'Up' ? 'text-green-400' : 'text-red-400'}>{t.outcome}</span>
                              <span>{t.shares?.toFixed(1)}sh</span>
                              <span>@ {t.price?.toFixed(3)}</span>
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
