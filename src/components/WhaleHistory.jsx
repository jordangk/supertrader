import React, { useState, useEffect, useMemo } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceDot, Area, Brush,
} from 'recharts';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function epochToTime(epoch) {
  const d = new Date(epoch * 1000);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

export default function WhaleHistory({ whaleTrades = [] }) {
  const [slugs, setSlugs] = useState([]);
  const [selectedSlug, setSelectedSlug] = useState(null);
  const [trades, setTrades] = useState([]);
  const [priceHistory, setPriceHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [chartWindowS, setChartWindowS] = useState(900);
  const [brushRange, setBrushRange] = useState(null);
  const [whaleHoldings, setWhaleHoldings] = useState(null);
  const [whalePositions, setWhalePositions] = useState(null);

  // Fetch all slugs — auto-select latest (request more for longer history)
  useEffect(() => {
    fetch(`${API_BASE}/api/whale-slugs?limit=50000`).then(r => r.json()).then(d => {
      const s = d.slugs || [];
      setSlugs(s);
      if (!selectedSlug && s.length > 0) setSelectedSlug(s[0].slug);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (whaleTrades.length > 0) {
      fetch(`${API_BASE}/api/whale-slugs?limit=50000`).then(r => r.json()).then(d => {
        const s = d.slugs || [];
        setSlugs(s);
        if (s.length > 0 && !s.some(x => x.slug === selectedSlug)) setSelectedSlug(s[0].slug);
      }).catch(() => {});
    }
  }, [whaleTrades.length]);

  // Fetch trades + price history for selected slug
  useEffect(() => {
    if (!selectedSlug) { setTrades([]); setPriceHistory([]); setWhaleHoldings(null); setWhalePositions(null); return; }
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/api/whale-trades?slug=${encodeURIComponent(selectedSlug)}&limit=1000`).then(r => r.json()),
      fetch(`${API_BASE}/api/price-history?slug=${encodeURIComponent(selectedSlug)}&limit=1000`).then(r => r.json()),
    ]).then(([td, ph]) => {
      setTrades(td.trades || []);
      setPriceHistory((ph.snapshots || []).map(s => ({
        t: new Date(s.observed_at.endsWith('Z') ? s.observed_at : s.observed_at + 'Z').getTime(),
        btc: parseFloat(s.coin_price) || parseFloat(s.btc_price) || null,
        up: s.up_cost != null ? parseFloat(s.up_cost) : null,
        down: s.down_cost != null ? parseFloat(s.down_cost) : null,
      })));
      setLoading(false);
    }).catch(() => { setTrades([]); setPriceHistory([]); setLoading(false); });
  }, [selectedSlug]);

  useEffect(() => {
    if (!selectedSlug) return;
    const is15m = selectedSlug.includes('-15m-');
    if (is15m) {
      fetch(`${API_BASE}/api/whale-holdings?slug=${encodeURIComponent(selectedSlug)}`)
        .then(r => r.json())
        .then(d => { setWhaleHoldings(d); setWhalePositions(null); })
        .catch(() => { setWhaleHoldings(null); });
    } else {
      fetch(`${API_BASE}/api/whale-positions?event=${encodeURIComponent(selectedSlug)}`)
        .then(r => r.json())
        .then(d => { setWhalePositions(d); setWhaleHoldings(null); })
        .catch(() => setWhalePositions(null));
    }
  }, [selectedSlug]);

  // Build chart data from price history
  const chartData = useMemo(() => {
    if (!priceHistory.length) return [];
    const base = priceHistory[0].t;
    const btcOpen = priceHistory.find(p => p.btc)?.btc || 0;
    return priceHistory.map(p => ({
      elapsed: Math.round((p.t - base) / 1000),
      btcDelta: p.btc ? p.btc - btcOpen : null,
      btcVal: p.btc,
      upPrice: p.up != null ? p.up * 100 : null,
      downPrice: p.down != null ? p.down * 100 : null,
    }));
  }, [priceHistory]);

  // Merge whale trades into chart data (5s buckets)
  const chartDataWithWhale = useMemo(() => {
    if (!chartData.length || !trades.length) return chartData;
    const base = priceHistory.length > 0 ? priceHistory[0].t : 0;
    const buckets = {};
    for (const t of trades) {
      const ts = (t.trade_timestamp || 0) * 1000 || Date.parse(t.created_at || 0);
      const rawElapsed = Math.round((ts - base) / 1000);
      const bucket = Math.round(rawElapsed / 5) * 5;
      if (!buckets[bucket]) buckets[bucket] = { buyUp: [], sellUp: [], buyDown: [], sellDown: [] };
      const isUp = /up/i.test(t.outcome);
      const shares = Math.abs(t.shares || 0);
      const usdc = Math.abs(t.usdc_size || 0);
      const price = shares > 0 ? usdc / shares : 0;
      const side = (t.shares || 0) >= 0 ? 'buy' : 'sell';
      const key = side === 'buy' ? (isUp ? 'buyUp' : 'buyDown') : (isUp ? 'sellUp' : 'sellDown');
      buckets[bucket][key].push({ shares, price, usdc });
    }
    const enriched = chartData.map(d => ({ ...d, whaleBuyUp: null, whaleSellUp: null, whaleBuyDown: null, whaleSellDown: null, whaleDetails: null }));
    const agg = (arr) => {
      if (!arr.length) return null;
      const totalUsdc = arr.reduce((s, t) => s + t.usdc, 0);
      const totalShares = arr.reduce((s, t) => s + t.shares, 0);
      const avgPrice = totalShares > 0 ? totalUsdc / totalShares : 0;
      return { usdc: totalUsdc, shares: totalShares, avgPrice, count: arr.length };
    };
    for (const [bucketStr, b] of Object.entries(buckets)) {
      const bucketElapsed = Number(bucketStr);
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < enriched.length; i++) {
        const dist = Math.abs(enriched[i].elapsed - bucketElapsed);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      if (bestDist > 30) continue;
      const bu = agg(b.buyUp), su = agg(b.sellUp), bd = agg(b.buyDown), sd = agg(b.sellDown);
      if (bu) enriched[best].whaleBuyUp = bu.avgPrice * 100;
      if (su) enriched[best].whaleSellUp = su.avgPrice * 100;
      if (bd) enriched[best].whaleBuyDown = bd.avgPrice * 100;
      if (sd) enriched[best].whaleSellDown = sd.avgPrice * 100;
      if (!enriched[best].whaleDetails) enriched[best].whaleDetails = {};
      if (bu) enriched[best].whaleDetails.buyUp = bu;
      if (su) enriched[best].whaleDetails.sellUp = su;
      if (bd) enriched[best].whaleDetails.buyDown = bd;
      if (sd) enriched[best].whaleDetails.sellDown = sd;
    }
    return enriched;
  }, [chartData, trades, priceHistory]);

  // Summary
  const summary = useMemo(() => {
    if (!trades.length) return null;
    let totalBuyUsdc = 0, totalSellUsdc = 0, totalBuyShares = 0, totalSellShares = 0;
    let upBuys = 0, downBuys = 0, upSells = 0, downSells = 0;
    for (const t of trades) {
      const usdc = Math.abs(t.usdc_size || 0);
      const shares = Math.abs(t.shares || 0);
      const isUp = /up/i.test(t.outcome);
      if ((t.shares || 0) >= 0) {
        totalBuyUsdc += usdc; totalBuyShares += shares;
        if (isUp) upBuys += usdc; else downBuys += usdc;
      } else {
        totalSellUsdc += usdc; totalSellShares += shares;
        if (isUp) upSells += usdc; else downSells += usdc;
      }
    }
    return { totalBuyUsdc, totalSellUsdc, totalBuyShares, totalSellShares, upBuys, downBuys, upSells, downSells };
  }, [trades]);

  // Flat list: every transaction, no nesting
  const flatTrades = useMemo(() => {
    if (!trades.length) return [];
    return trades.map(t => {
      const ts = t.trade_timestamp || Math.floor(Date.parse(t.created_at || 0) / 1000);
      const shares = Math.abs(t.shares || 0);
      const usdc = Math.abs(t.usdc_size || 0);
      const price = shares > 0 ? usdc / shares : 0;
      const side = (t.shares || 0) >= 0 ? 'buy' : 'sell';
      return { ts, outcome: t.outcome, shares, usdc, price, side };
    }).sort((a, b) => a.ts - b.ts);
  }, [trades]);

  // Chart dots: one per trade (no 5s bucket aggregation)
  const whaleChartDots = useMemo(() => {
    if (!chartData.length || !trades.length || !priceHistory.length) return [];
    const base = priceHistory[0].t;
    return trades.map(t => {
      const ts = (t.trade_timestamp || 0) * 1000 || Date.parse(t.created_at || 0);
      const elapsed = Math.round((ts - base) / 1000);
      const shares = Math.abs(t.shares || 0);
      const usdc = Math.abs(t.usdc_size || 0);
      const price = shares > 0 ? (usdc / shares) * 100 : 0;
      const isUp = /up/i.test(t.outcome);
      const side = (t.shares || 0) >= 0 ? 'buy' : 'sell';
      return { elapsed, price, side, isUp };
    }).filter(d => d.price > 0 && d.price <= 100);
  }, [chartData, trades, priceHistory]);

  const formatElapsed = (secs) => `${Math.floor(secs / 60)}:${String(Math.abs(secs % 60)).padStart(2, '0')}`;

  // Brush range: user selection or preset zoom
  const { startIndex, endIndex } = useMemo(() => {
    const d = chartDataWithWhale;
    if (!d.length) return { startIndex: 0, endIndex: 0 };
    if (brushRange) return brushRange;
    if (chartWindowS >= 900) return { startIndex: 0, endIndex: d.length - 1 };
    const maxE = d[d.length - 1]?.elapsed || 0;
    const minE = Math.max(0, maxE - chartWindowS);
    let si = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i].elapsed >= minE) { si = i; break; }
    }
    return { startIndex: si, endIndex: d.length - 1 };
  }, [chartDataWithWhale, brushRange, chartWindowS]);

  const WhaleTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    if (!d) return null;
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs">
        <div className="text-gray-400">{d.elapsed}s elapsed</div>
        {d.btcDelta != null && <div className={d.btcDelta >= 0 ? 'text-green-400' : 'text-red-400'}>BTC: {d.btcDelta >= 0 ? '+' : ''}${d.btcDelta.toFixed(2)}</div>}
        {d.btcVal && <div className="text-yellow-400">BTC: ${d.btcVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
        {d.upPrice != null && <div className="text-green-300">Up: {d.upPrice.toFixed(1)}¢</div>}
        {d.downPrice != null && <div className="text-red-300">Down: {d.downPrice.toFixed(1)}¢</div>}
        {d.whaleDetails && (
          <div className="border-t border-gray-700 mt-1 pt-1">
            <div className="text-gray-400 font-bold">@0x8dxd</div>
            {d.whaleDetails.buyUp && <div className="text-green-400">Buy Up: {d.whaleDetails.buyUp.shares.toFixed(1)}sh @ {(d.whaleDetails.buyUp.avgPrice * 100).toFixed(1)}¢ (${d.whaleDetails.buyUp.usdc.toFixed(2)})</div>}
            {d.whaleDetails.sellUp && <div className="text-red-400">Sell Up: {d.whaleDetails.sellUp.shares.toFixed(1)}sh @ {(d.whaleDetails.sellUp.avgPrice * 100).toFixed(1)}¢ (${d.whaleDetails.sellUp.usdc.toFixed(2)})</div>}
            {d.whaleDetails.buyDown && <div className="text-green-400">Buy Down: {d.whaleDetails.buyDown.shares.toFixed(1)}sh @ {(d.whaleDetails.buyDown.avgPrice * 100).toFixed(1)}¢ (${d.whaleDetails.buyDown.usdc.toFixed(2)})</div>}
            {d.whaleDetails.sellDown && <div className="text-red-400">Sell Down: {d.whaleDetails.sellDown.shares.toFixed(1)}sh @ {(d.whaleDetails.sellDown.avgPrice * 100).toFixed(1)}¢ (${d.whaleDetails.sellDown.usdc.toFixed(2)})</div>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-gray-200">Whale Tracker — @0x8dxd</h2>
        <p className="text-xs text-gray-500 mt-0.5">15m BTC Up/Down events. Select an event to see chart + trades.</p>
      </div>

      {/* Event browser — scrollable when many events */}
      <div className="flex items-center gap-2 flex-wrap max-h-[500px] overflow-y-auto overflow-x-hidden">
        {slugs.length === 0 && <div className="text-sm text-gray-500 py-2">No whale events yet</div>}
        {slugs.map(({ slug, ts }, idx) => {
          const epoch = slug.match(/-(\d+)$/)?.[1];
          const isSelected = slug === selectedSlug;
          return (
            <button
              key={`${slug}-${idx}`}
              onClick={() => setSelectedSlug(isSelected ? null : slug)}
              className={`px-3 py-2 rounded-lg border text-xs font-bold transition-all ${
                isSelected
                  ? 'border-cyan-500 bg-cyan-950/40 text-cyan-300'
                  : 'border-gray-800 bg-gray-900/50 text-gray-400 hover:border-gray-600 hover:text-gray-200'
              }`}
            >
              {epoch ? epochToTime(parseInt(epoch)) : slug}
            </button>
          );
        })}
      </div>

      {/* Selected event detail */}
      {selectedSlug && !loading && (
        <div className="space-y-3">
          {/* Whale holdings — 15m: DB/Alchemy, else: Polymarket */}
          {whaleHoldings && selectedSlug?.includes('-15m-') && (
            <div className="flex items-center gap-4 px-4 py-3 rounded-lg border border-cyan-800/50 bg-cyan-950/20 text-sm">
              <span className="text-gray-500 font-bold">@0x8dxd (DB/Alchemy 15m)</span>
              <span className="text-green-400 font-mono font-bold">{(whaleHoldings.up ?? 0).toFixed(1)} Up</span>
              <span className="text-red-400 font-mono font-bold">{(whaleHoldings.down ?? 0).toFixed(1)} Down</span>
            </div>
          )}
          {whalePositions && !whalePositions.error && !selectedSlug?.includes('-15m-') && (
            <div className="flex items-center gap-4 px-4 py-3 rounded-lg border border-gray-800/50 bg-gray-900/60 text-sm">
              <span className="text-gray-500 font-bold">@0x8dxd (Polymarket)</span>
              <span className="text-green-400 font-mono font-bold">{(whalePositions.totalUp ?? 0).toFixed(1)} Up</span>
              <span className="text-red-400 font-mono font-bold">{(whalePositions.totalDown ?? 0).toFixed(1)} Down</span>
              <span className="text-yellow-400 font-mono font-bold">${(whalePositions.totalValue ?? 0).toFixed(2)} value</span>
            </div>
          )}
          {/* Summary cards */}
          {summary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div className="rounded-lg border border-green-800/50 bg-green-950/20 px-3 py-2">
                <div className="text-[10px] text-gray-500 uppercase">Buy Up</div>
                <div className="text-sm font-bold text-green-400">${summary.upBuys.toFixed(2)}</div>
              </div>
              <div className="rounded-lg border border-green-800/50 bg-green-950/20 px-3 py-2">
                <div className="text-[10px] text-gray-500 uppercase">Buy Down</div>
                <div className="text-sm font-bold text-green-400">${summary.downBuys.toFixed(2)}</div>
              </div>
              <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2">
                <div className="text-[10px] text-gray-500 uppercase">Sell Up</div>
                <div className="text-sm font-bold text-red-400">${summary.upSells.toFixed(2)}</div>
              </div>
              <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2">
                <div className="text-[10px] text-gray-500 uppercase">Sell Down</div>
                <div className="text-sm font-bold text-red-400">${summary.downSells.toFixed(2)}</div>
              </div>
            </div>
          )}

          {summary && (
            <div className="flex items-center gap-4 text-xs text-gray-400">
              <span>Bought: <span className="text-green-400 font-bold">${summary.totalBuyUsdc.toFixed(2)}</span> ({summary.totalBuyShares.toFixed(0)}sh)</span>
              <span>Sold: <span className="text-red-400 font-bold">${summary.totalSellUsdc.toFixed(2)}</span> ({summary.totalSellShares.toFixed(0)}sh)</span>
              <span>Net: <span className="text-yellow-400 font-bold">${(summary.totalBuyUsdc - summary.totalSellUsdc).toFixed(2)}</span></span>
            </div>
          )}

          {/* Chart */}
          {chartDataWithWhale.length > 0 && (
            <>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs text-gray-500">Zoom</span>
                <div className="flex gap-1 flex-wrap">
                  {[60, 120, 180, 300, 600, 900].map(s => (
                    <button key={s} onClick={() => { setChartWindowS(s); setBrushRange(null); }}
                      className={`px-2 py-0.5 rounded text-xs font-bold transition-colors ${chartWindowS === s && !brushRange ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    >{s < 60 ? `${s}s` : `${s / 60}m`}</button>
                  ))}
                  {brushRange && (
                    <button onClick={() => setBrushRange(null)}
                      className="px-2 py-0.5 rounded text-xs font-bold bg-cyan-600 text-white hover:bg-cyan-500 transition-colors"
                    >Reset zoom</button>
                  )}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={380}>
                <ComposedChart data={chartDataWithWhale} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis dataKey="elapsed" tickFormatter={formatElapsed} stroke="#666" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis yAxisId="btc" orientation="left" width={50} stroke="#eab308" tick={{ fontSize: 11 }} tickFormatter={v => `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(0)}`} domain={['auto', 'auto']} />
                  <YAxis yAxisId="poly" orientation="right" width={40} stroke="#4ade80" tick={{ fontSize: 11 }} tickFormatter={v => `${v.toFixed(0)}¢`} domain={[0, 100]} />
                  <Tooltip content={<WhaleTooltip />} position={{ x: 70, y: 0 }} />
                  <ReferenceLine yAxisId="btc" y={0} stroke="#555" strokeDasharray="3 3" />
                  <Area yAxisId="btc" dataKey="btcDelta" stroke="#eab308" fill="#eab30822" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                  <Line yAxisId="poly" dataKey="upPrice" stroke="#4ade80" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                  <Line yAxisId="poly" dataKey="downPrice" stroke="#f87171" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                  {/* Whale dots — every trade, no nesting */}
                  {whaleChartDots.map((d, i) => (
                    <ReferenceDot key={`whale-${i}`} yAxisId="poly" x={d.elapsed} y={d.price} r={4}
                      fill={d.side === 'buy' ? '#22c55e' : '#ef4444'} fillOpacity={0.85} stroke="#fff" strokeWidth={1} />
                  ))}
                  <Brush
                    dataKey="elapsed"
                    height={30}
                    stroke="#444"
                    fill="#1f2937"
                    tickFormatter={formatElapsed}
                    startIndex={startIndex}
                    endIndex={endIndex}
                    onChange={(newState) => {
                      if (newState?.startIndex != null && newState?.endIndex != null) {
                        setBrushRange({ startIndex: newState.startIndex, endIndex: newState.endIndex });
                      }
                    }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center justify-center gap-6 text-xs">
                <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-yellow-500 inline-block"></span> BTC $</span>
                <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-green-400 inline-block"></span> Up</span>
                <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-red-400 inline-block"></span> Down</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-500 rounded-full inline-block border border-white"></span> Whale Buy</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-red-500 rounded-full inline-block border border-white"></span> Whale Sell</span>
              </div>
            </>
          )}

          {/* Trade log — every transaction, no nesting */}
          <div className="space-y-1 max-h-[600px] overflow-y-auto">
            {flatTrades.filter(t => t.usdc >= 0.01).map((t, i) => {
              const timeStr = new Date(t.ts * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
              const isUp = /up/i.test(t.outcome);
              return (
                <div key={`${t.ts}-${i}`} className="flex items-center gap-3 px-3 py-1.5 rounded border border-gray-800/50 bg-gray-900/60 text-xs">
                  <span className="text-gray-500 font-mono w-24 shrink-0">{timeStr}</span>
                  <span className={t.side === 'buy' ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
                    {t.side === 'buy' ? 'BUY' : 'SELL'}
                  </span>
                  <span className={isUp ? 'text-green-300' : 'text-red-300'}>{t.shares.toFixed(1)} {isUp ? 'Up' : 'Down'}</span>
                  <span className="text-gray-400">at {(t.price * 100).toFixed(1)}¢</span>
                  <span className="text-yellow-400 font-mono font-bold">${t.usdc.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selectedSlug && loading && (
        <div className="text-sm text-gray-500 text-center py-8">Loading...</div>
      )}
    </div>
  );
}
