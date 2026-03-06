import React, { useEffect, useState, useRef } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const REFRESH_MS = 2000;

function fmt(n, d = 2) { return n != null ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'; }

export default function PriceTracker({ btc, binanceBtc, prices, event }) {
  const [snapshots, setSnapshots] = useState([]);
  const [pastEvents, setPastEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const tableRef = useRef(null);
  const prevBtc = useRef(null);
  const prevBinance = useRef(null);

  async function load() {
    const slug = event?.slug;
    if (!slug) return;
    try {
      const r = await fetch(`${API_BASE}/api/price-history?slug=${slug}&limit=1000`);
      const d = await r.json();
      setSnapshots(d.snapshots || []);
    } catch {}
    setLoading(false);
  }

  async function loadArchive() {
    try {
      const r = await fetch(`${API_BASE}/api/event-archive`);
      const d = await r.json();
      setPastEvents(d.events || []);
    } catch {}
  }

  useEffect(() => {
    load();
    loadArchive();
    const t = setInterval(load, REFRESH_MS);
    const t2 = setInterval(loadArchive, 30000);
    return () => { clearInterval(t); clearInterval(t2); };
  }, [event?.slug]);

  // Auto-scroll to bottom on new data
  useEffect(() => {
    if (tableRef.current) {
      tableRef.current.scrollTop = tableRef.current.scrollHeight;
    }
  }, [snapshots.length]);

  // Price direction flash
  const btcDir = btc.current != null && prevBtc.current != null
    ? (btc.current > prevBtc.current ? 'up' : btc.current < prevBtc.current ? 'down' : null) : null;
  const binDir = binanceBtc != null && prevBinance.current != null
    ? (binanceBtc > prevBinance.current ? 'up' : binanceBtc < prevBinance.current ? 'down' : null) : null;

  useEffect(() => { prevBtc.current = btc.current; });
  useEffect(() => { prevBinance.current = binanceBtc; });

  const dirColor = (dir) => dir === 'up' ? 'text-green-400' : dir === 'down' ? 'text-red-400' : 'text-white';

  // Live delta between the two feeds
  const liveDelta = btc.current != null && binanceBtc != null ? btc.current - binanceBtc : null;

  if (loading) {
    return (
      <div className="space-y-3">
        {[1,2,3].map(i => (
          <div key={i} className="bg-gray-900 rounded-xl border border-gray-800 p-4 animate-pulse">
            <div className="h-4 bg-gray-800 rounded w-1/3 mb-3" />
            <div className="h-3 bg-gray-800 rounded w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Live comparison ticker */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-gray-500 uppercase tracking-wider font-bold">BTC Price Comparison — Live</span>
          <span className="text-[10px] text-gray-600 font-mono">1s snapshots</span>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-3">
          {/* Polymarket Chainlink */}
          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Polymarket (Chainlink)</div>
            <div className={`text-2xl font-bold font-mono ${dirColor(btcDir)} transition-colors`}>
              ${fmt(btc.current, 2)}
            </div>
          </div>
          {/* Binance */}
          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Binance</div>
            <div className={`text-2xl font-bold font-mono ${dirColor(binDir)} transition-colors`}>
              ${fmt(binanceBtc, 2)}
            </div>
          </div>
        </div>
        {/* Up / Down contract prices */}
        {(prices?.upPrice != null || prices?.downPrice != null) && (
          <div className="grid grid-cols-2 gap-4 mb-3">
            <div className="bg-green-950/30 border border-green-900/50 rounded-lg p-2 text-center">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Up</div>
              <div className="text-lg font-bold font-mono text-green-400">
                {prices.upPrice ? (prices.upPrice * 100).toFixed(1) + '¢' : '—'}
              </div>
            </div>
            <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-2 text-center">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Down</div>
              <div className="text-lg font-bold font-mono text-red-400">
                {prices.downPrice ? (prices.downPrice * 100).toFixed(1) + '¢' : '—'}
              </div>
            </div>
          </div>
        )}
        {/* Delta */}
        {liveDelta != null && (
          <div className="flex items-center justify-center gap-2 bg-gray-800/30 rounded-lg py-2 px-3">
            <span className="text-[10px] text-gray-500 uppercase">Delta (Poly - Binance)</span>
            <span className={`text-lg font-bold font-mono ${liveDelta > 0 ? 'text-green-400' : liveDelta < 0 ? 'text-red-400' : 'text-gray-400'}`}>
              {liveDelta >= 0 ? '+' : ''}{fmt(liveDelta, 2)}
            </span>
            {Math.abs(liveDelta) > 5 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${liveDelta > 0 ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}`}>
                {liveDelta > 0 ? 'Poly leads' : 'Binance leads'}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Snapshot table — both prices over time */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <span className="text-sm font-semibold text-gray-300">Price History — Polymarket vs Binance</span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-600">{snapshots.length} ticks</span>
            {event?.slug && (
              <a
                href={`${API_BASE}/api/price-csv?slug=${event.slug}`}
                download
                className="text-[10px] px-2 py-1 rounded bg-orange-900/40 text-orange-400 hover:bg-orange-800/50 transition-colors font-medium"
              >
                CSV
              </a>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[750px]">
            <thead>
              <tr className="text-[10px] text-gray-600 uppercase tracking-wider border-b border-gray-800">
                <th className="py-2 px-1 text-left font-normal">Timestamp</th>
                <th className="py-2 px-1 text-right font-normal">Poly BTC</th>
                <th className="py-2 px-1 text-right font-normal">Chg</th>
                <th className="py-2 px-1 text-right font-normal">Binance</th>
                <th className="py-2 px-1 text-right font-normal">Chg</th>
                <th className="py-2 px-1 text-right font-normal">Delta</th>
                <th className="py-2 px-1 text-right font-normal text-green-700">Up</th>
                <th className="py-2 px-1 text-right font-normal text-green-700">Chg</th>
                <th className="py-2 px-1 text-right font-normal text-red-700">Down</th>
                <th className="py-2 px-1 text-right font-normal text-red-700">Chg</th>
              </tr>
            </thead>
          </table>
          <div ref={tableRef} className="max-h-[500px] overflow-y-auto overflow-x-auto">
            <table className="w-full min-w-[750px]">
              <tbody>
            {snapshots.map((s, i) => {
              const time = s.observed_at ? new Date(s.observed_at).getTime() : '';
              const delta = s.btc_price && s.coin_price ? s.btc_price - s.coin_price : null;
              const prev = i > 0 ? snapshots[i - 1] : null;
              const polyChg = prev && s.btc_price && prev.btc_price ? s.btc_price - prev.btc_price : null;
              const binChg = prev && s.coin_price && prev.coin_price ? s.coin_price - prev.coin_price : null;
              const upCents = s.up_cost != null ? s.up_cost * 100 : null;
              const downCents = s.down_cost != null ? s.down_cost * 100 : null;
              const prevUpCents = prev && prev.up_cost != null ? prev.up_cost * 100 : null;
              const prevDownCents = prev && prev.down_cost != null ? prev.down_cost * 100 : null;
              const upChg = upCents != null && prevUpCents != null ? upCents - prevUpCents : null;
              const downChg = downCents != null && prevDownCents != null ? downCents - prevDownCents : null;
              const chgColor = (v) => v != null ? (v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-600') : 'text-gray-600';

              return (
                <tr key={i} className="text-xs font-mono border-b border-gray-800/50">
                  <td className="py-1 px-1 text-gray-500">{time}</td>
                  <td className={`py-1 px-1 text-right ${chgColor(polyChg)}`}>
                    {s.btc_price ? '$' + fmt(s.btc_price, 2) : '—'}
                  </td>
                  <td className={`py-1 px-1 text-right ${chgColor(polyChg)}`}>
                    {polyChg != null ? (polyChg >= 0 ? '+' : '') + fmt(polyChg, 2) : '—'}
                  </td>
                  <td className={`py-1 px-1 text-right ${chgColor(binChg)}`}>
                    {s.coin_price ? '$' + fmt(s.coin_price, 2) : '—'}
                  </td>
                  <td className={`py-1 px-1 text-right ${chgColor(binChg)}`}>
                    {binChg != null ? (binChg >= 0 ? '+' : '') + fmt(binChg, 2) : '—'}
                  </td>
                  <td className={`py-1 px-1 text-right ${chgColor(delta)}`}>
                    {delta != null ? (delta >= 0 ? '+' : '') + fmt(delta, 2) : '—'}
                  </td>
                  <td className="py-1 px-1 text-right text-green-400">
                    {upCents != null ? upCents.toFixed(1) + '¢' : '—'}
                  </td>
                  <td className={`py-1 px-1 text-right ${chgColor(upChg)}`}>
                    {upChg != null ? (upChg >= 0 ? '+' : '') + upChg.toFixed(1) : '—'}
                  </td>
                  <td className="py-1 px-1 text-right text-red-400">
                    {downCents != null ? downCents.toFixed(1) + '¢' : '—'}
                  </td>
                  <td className={`py-1 px-1 text-right ${chgColor(downChg)}`}>
                    {downChg != null ? (downChg >= 0 ? '+' : '') + downChg.toFixed(1) : '—'}
                  </td>
                </tr>
              );
            })}
            {!snapshots.length && (
              <tr><td colSpan={10} className="text-gray-600 text-sm py-4 text-center">Collecting price snapshots on every tick...</td></tr>
            )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Past events archive */}
      {pastEvents.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800">
            <span className="text-sm font-semibold text-gray-300">Past Events</span>
          </div>
          <div className="divide-y divide-gray-800/50">
            {pastEvents.map(ev => {
              const time = ev.start_time ? new Date(ev.start_time).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
              const polyDelta = ev.poly_btc_start && ev.poly_btc_end ? ev.poly_btc_end - ev.poly_btc_start : null;
              const upEnd = ev.up_end != null ? (ev.up_end * 100).toFixed(0) : null;
              const downEnd = ev.down_end != null ? (ev.down_end * 100).toFixed(0) : null;
              const winner = upEnd != null && downEnd != null ? (Number(upEnd) > Number(downEnd) ? 'UP' : 'DOWN') : null;

              return (
                <div key={ev.slug} className="flex items-center justify-between px-4 py-2.5 text-xs font-mono">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-gray-500 shrink-0">{time}</span>
                    <span className="text-gray-400 truncate">{ev.slug.replace('btc-updown-5m-', '')}</span>
                    {ev.is_current && <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-900/40 text-orange-400 font-bold shrink-0">LIVE</span>}
                    {winner && !ev.is_current && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold shrink-0 ${winner === 'UP' ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                        {winner}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-gray-500">{ev.count} ticks</span>
                    {polyDelta != null && (
                      <span className={polyDelta >= 0 ? 'text-green-400' : 'text-red-400'}>
                        {polyDelta >= 0 ? '+' : ''}{fmt(polyDelta, 0)}
                      </span>
                    )}
                    {upEnd && <span className="text-green-400">{upEnd}¢</span>}
                    {downEnd && <span className="text-red-400">{downEnd}¢</span>}
                    <a
                      href={`${API_BASE}/api/price-csv?slug=${ev.slug}`}
                      download
                      className="px-2 py-1 rounded bg-orange-900/40 text-orange-400 hover:bg-orange-800/50 transition-colors font-medium text-[10px]"
                    >
                      CSV
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
