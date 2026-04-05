import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function fmtCents(v) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}¢`;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function Btc5mTrader() {
  const [state, setState] = useState({
    eventSlug: null, tokenUp: null, tokenDown: null,
    upPrice: null, downPrice: null, btcStart: null, btcCurrent: null,
    endTime: null, title: null, tickSize: '0.01', negRisk: false,
  });
  const [history, setHistory] = useState([]);
  const [chartWindowS, setChartWindowS] = useState(180); // 3m default
  const [buyStatus, setBuyStatus] = useState(null);
  const [pos, setPos] = useState({ up: null, down: null });
  const wsRef = useRef(null);
  const lastSlug = useRef(null);
  const [auto99, setAuto99] = useState(false);
  const auto99Ref = useRef({ enabled: false, firedSlug: null, priceLog: [] });

  // --- WebSocket for live prices ---
  useEffect(() => {
    function connect() {
      const apiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:3001').trim();
      const url = new URL(apiUrl);
      const wsUrl = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'btc5m_prices') {
            setState(prev => ({ ...prev, ...msg }));
          }
        } catch {}
      };
      ws.onclose = () => setTimeout(connect, 2000);
      ws.onerror = () => ws.close();
    }
    connect();
    return () => wsRef.current?.close();
  }, []);

  // --- Poll /api/btc5m/event every 2s ---
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const [evRes, binRes] = await Promise.all([
          fetch(`${API_BASE}/api/btc5m/event`).then(r => r.json()).catch(() => null),
          fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then(r => r.json()).catch(() => null),
        ]);
        if (!active) return;
        if (evRes) {
          const btcLive = binRes?.price ? parseFloat(binRes.price) : evRes.btcCurrent;
          setState(prev => ({
            ...prev,
            ...evRes,
            btcCurrent: btcLive ?? evRes.btcCurrent ?? prev.btcCurrent,
          }));
        }
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 2000);
    // Poll auto-99 status
    const a99iv = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/btc5m/auto99/status`);
        const d = await r.json();
        setAuto99(d.enabled);
      } catch {}
    }, 5000);
    return () => { active = false; clearInterval(iv); clearInterval(a99iv); };
  }, []);

  // --- Fetch history when slug changes ---
  useEffect(() => {
    if (!state.eventSlug || state.eventSlug === lastSlug.current) return;
    lastSlug.current = state.eventSlug;
    fetch(`${API_BASE}/api/btc5m/price-history?slug=${encodeURIComponent(state.eventSlug)}&limit=500`)
      .then(r => r.json())
      .then(d => {
        const snaps = (d.snapshots || []).map(s => ({
          t: new Date(s.observed_at.endsWith('Z') ? s.observed_at : s.observed_at + 'Z').getTime(),
          btc: s.btc_price != null ? parseFloat(s.btc_price) : null,
          up: s.up_cost != null ? parseFloat(s.up_cost) : null,
          down: s.down_cost != null ? parseFloat(s.down_cost) : null,
          secsLeft: s.seconds_left,
        }));
        setHistory(snaps);
      })
      .catch(() => {});
  }, [state.eventSlug]);

  // --- Append live ticks to history ---
  useEffect(() => {
    if (state.upPrice == null && state.downPrice == null) return;
    setHistory(prev => {
      const now = Date.now();
      const point = {
        t: now,
        btc: state.btcCurrent,
        up: state.upPrice,
        down: state.downPrice,
      };
      // Deduplicate: skip if last point is < 500ms ago
      if (prev.length > 0 && now - prev[prev.length - 1].t < 500) return prev;
      const next = [...prev, point];
      return next.length > 2000 ? next.slice(-2000) : next;
    });
  }, [state.upPrice, state.downPrice, state.btcCurrent]);

  // --- Poll positions ---
  useEffect(() => {
    const fetchPos = () => {
      if (!state.tokenUp && !state.tokenDown) return;
      fetch(`${API_BASE}/api/positions`)
        .then(r => r.json())
        .then(d => {
          const positions = d.positions || d || [];
          let up = null, down = null;
          for (const p of positions) {
            if (p.asset === state.tokenUp) up = p;
            else if (p.asset === state.tokenDown) down = p;
          }
          setPos({ up, down });
        })
        .catch(() => {});
    };
    fetchPos();
    const iv = setInterval(fetchPos, 5000);
    return () => clearInterval(iv);
  }, [state.tokenUp, state.tokenDown]);

  // --- Chart data ---
  const chartData = useMemo(() => {
    if (history.length === 0) return [];
    const cutoff = Date.now() - chartWindowS * 1000;
    const filtered = history.filter(h => h.t >= cutoff);
    const btcBase = filtered.find(h => h.btc != null)?.btc;
    return filtered.map(h => ({
      t: h.t,
      time: fmtTime(h.t),
      btcPct: btcBase && h.btc != null ? ((h.btc - btcBase) / btcBase) * 100 : null,
      upCents: h.up != null ? h.up * 100 : null,
      downCents: h.down != null ? h.down * 100 : null,
    }));
  }, [history, chartWindowS]);

  // --- Countdown ---
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const secsLeft = state.endTime ? Math.max(0, Math.floor((new Date(state.endTime) - Date.now()) / 1000)) : null;
  const mmss = secsLeft != null ? `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}` : '--:--';

  // --- Buy handler ---
  async function doBuy(side, shares, offsetCents) {
    const basePrice = side === 'up' ? state.upPrice : state.downPrice;
    if (!basePrice) { setBuyStatus({ side, msg: 'No price', ok: false }); return; }
    const limitPrice = Math.round((basePrice * 100 + offsetCents)) / 100;
    if (limitPrice <= 0 || limitPrice >= 1) { setBuyStatus({ side, msg: 'Bad price', ok: false }); return; }
    setBuyStatus({ side, msg: 'Sending...', ok: true });
    try {
      const res = await fetch(`${API_BASE}/api/btc5m/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares, limitPrice }),
      });
      const d = await res.json();
      setBuyStatus({ side, msg: d.error || `${d.shares}sh @ ${(d.price * 100).toFixed(0)}¢`, ok: !d.error });
    } catch (e) {
      setBuyStatus({ side, msg: e.message, ok: false });
    }
    setTimeout(() => setBuyStatus(null), 3000);
  }

  // --- Limit buy handler ---
  async function doLimit(side, offsetCents) {
    const basePrice = side === 'up' ? state.upPrice : state.downPrice;
    if (!basePrice) { setBuyStatus({ side, msg: 'No price', ok: false }); return; }
    const limitPrice = Math.round((basePrice * 100 + offsetCents)) / 100;
    if (limitPrice <= 0 || limitPrice >= 1) { setBuyStatus({ side, msg: 'Bad price', ok: false }); return; }
    setBuyStatus({ side, msg: 'Limit...', ok: true });
    try {
      const res = await fetch(`${API_BASE}/api/btc5m/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares: 5, limitPrice, orderType: 'GTC' }),
      });
      const d = await res.json();
      setBuyStatus({ side, msg: d.error || `L ${(d.price * 100).toFixed(0)}¢`, ok: !d.error });
    } catch (e) {
      setBuyStatus({ side, msg: e.message, ok: false });
    }
    setTimeout(() => setBuyStatus(null), 3000);
  }

  // --- Both sides handler ---
  async function doBoth(offsetCents) {
    setBuyStatus({ side: 'both', msg: 'Sending...', ok: true });
    try {
      const upLim = state.upPrice ? Math.round((state.upPrice * 100 + offsetCents)) / 100 : null;
      const downLim = state.downPrice ? Math.round((state.downPrice * 100 + offsetCents)) / 100 : null;
      const promises = [];
      if (upLim && upLim > 0 && upLim < 1) {
        promises.push(fetch(`${API_BASE}/api/btc5m/buy`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ side: 'up', shares: 5, limitPrice: upLim, orderType: 'GTC' }),
        }).then(r => r.json()));
      }
      if (downLim && downLim > 0 && downLim < 1) {
        promises.push(fetch(`${API_BASE}/api/btc5m/buy`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ side: 'down', shares: 5, limitPrice: downLim, orderType: 'GTC' }),
        }).then(r => r.json()));
      }
      await Promise.all(promises);
      setBuyStatus({ side: 'both', msg: 'Sent both', ok: true });
    } catch (e) {
      setBuyStatus({ side: 'both', msg: e.message, ok: false });
    }
    setTimeout(() => setBuyStatus(null), 3000);
  }

  // --- Auto-99 logic ---
  useEffect(() => {
    auto99Ref.current.enabled = auto99;
  }, [auto99]);

  // Reset firedSlug when event changes
  useEffect(() => {
    auto99Ref.current.firedSlug = null;
    auto99Ref.current.priceLog = [];
  }, [state.eventSlug]);

  useEffect(() => {
    const iv = setInterval(() => {
      const ref = auto99Ref.current;
      if (!ref.enabled) return;
      if (!state.eventSlug || !state.endTime) return;
      if (ref.firedSlug === state.eventSlug) return; // already fired this event

      const up = state.upPrice;
      const down = state.downPrice;
      if (!up || !down) return;

      const winningSide = up > down ? 'up' : 'down';
      const winningPrice = Math.max(up, down);

      // Log price every tick
      const now = Date.now();
      ref.priceLog.push({ t: now, price: winningPrice, side: winningSide });
      // Keep last 90 seconds of data
      ref.priceLog = ref.priceLog.filter(p => now - p.t < 90000);

      // Check conditions:
      // 1. Last 5 seconds of the event
      const secsLeft = Math.max(0, (new Date(state.endTime).getTime() - now) / 1000);
      if (secsLeft > 5 || secsLeft < 0) return;

      // 2. Current price > 90¢
      if (winningPrice < 0.90) return;

      // 3. Been over 80¢ for the past minute (all entries in last 60s)
      const lastMinute = ref.priceLog.filter(p => now - p.t < 60000);
      if (lastMinute.length < 5) return; // need at least some data
      const allAbove80 = lastMinute.every(p => p.price >= 0.80);
      if (!allAbove80) return;

      // 4. Same side the whole time
      const sameSide = lastMinute.every(p => p.side === winningSide);
      if (!sameSide) return;

      // All conditions met — fire!
      ref.firedSlug = state.eventSlug;
      console.log(`[auto-99] FIRING: ${winningSide} @ 99¢ (price ${(winningPrice*100).toFixed(0)}¢, ${secsLeft.toFixed(1)}s left)`);

      fetch(`${API_BASE}/api/btc5m/limit99`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).then(r => r.json()).then(d => {
        setBuyStatus({ side: winningSide, msg: `Auto-99: ${winningSide} @ 99¢ ${d.filled ? 'FILLED' : d.status || 'sent'}`, ok: d.ok });
        setTimeout(() => setBuyStatus(null), 5000);
      }).catch(() => {});
    }, 1000);
    return () => clearInterval(iv);
  }, [state.upPrice, state.downPrice, state.endTime, state.eventSlug]);

  // --- 99c Winner handler ---
  async function doLimit99() {
    setBuyStatus({ side: 'winner', msg: 'Sending 99¢...', ok: true });
    try {
      const res = await fetch(`${API_BASE}/api/btc5m/limit99`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const d = await res.json();
      setBuyStatus({ side: 'winner', msg: d.error || `${d.side?.toUpperCase()} 5sh @ 99¢`, ok: !d.error });
    } catch (e) {
      setBuyStatus({ side: 'winner', msg: e.message, ok: false });
    }
    setTimeout(() => setBuyStatus(null), 3000);
  }

  const upCents = state.upPrice != null ? (state.upPrice * 100).toFixed(1) : '—';
  const downCents = state.downPrice != null ? (state.downPrice * 100).toFixed(1) : '—';
  const btcPctChange = state.btcStart && state.btcCurrent
    ? ((state.btcCurrent - state.btcStart) / state.btcStart * 100).toFixed(3)
    : null;

  // Positions summary
  const upShares = pos.up ? parseFloat(pos.up.size || 0) : 0;
  const downShares = pos.down ? parseFloat(pos.down.size || 0) : 0;
  const upAvgPrice = pos.up ? parseFloat(pos.up.avgPrice || 0) : 0;
  const downAvgPrice = pos.down ? parseFloat(pos.down.avgPrice || 0) : 0;
  const upCost = upShares * upAvgPrice;
  const downCost = downShares * downAvgPrice;
  const upValue = upShares * (state.upPrice || 0);
  const downValue = downShares * (state.downPrice || 0);
  const totalPnl = (upValue - upCost) + (downValue - downCost);

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-3">
        <div className="flex items-center justify-between mb-1">
          <div>
            <span className="text-sm font-bold text-yellow-400">BTC 5m</span>
            <span className="text-[10px] text-gray-500 ml-2">{state.eventSlug || 'loading...'}</span>
          </div>
          <div className="text-right">
            <span className={`text-lg font-mono font-bold ${secsLeft != null && secsLeft < 30 ? 'text-red-400 animate-pulse' : 'text-white'}`}>
              {mmss}
            </span>
          </div>
        </div>
        <div className="flex gap-4 text-xs font-mono">
          <span className="text-gray-400">BTC: <span className="text-yellow-300">${state.btcCurrent?.toFixed(0) || '—'}</span></span>
          <span className="text-gray-400">
            {btcPctChange != null ? (
              <span className={parseFloat(btcPctChange) >= 0 ? 'text-green-400' : 'text-red-400'}>
                {parseFloat(btcPctChange) >= 0 ? '+' : ''}{btcPctChange}%
              </span>
            ) : '—'}
          </span>
          <span className="text-green-400">Up: {upCents}¢</span>
          <span className="text-red-400">Down: {downCents}¢</span>
        </div>
      </div>

      {/* Chart */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-2">
        <div className="flex gap-1 mb-1">
          {[{ s: 60, label: '1m' }, { s: 120, label: '2m' }, { s: 180, label: '3m' }, { s: 300, label: '5m' }].map(z => (
            <button key={z.s} onClick={() => setChartWindowS(z.s)}
              className={`px-2 py-0.5 rounded text-[10px] font-bold ${chartWindowS === z.s ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-500'}`}>
              {z.label}
            </button>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#666' }} interval="preserveStartEnd" />
            <YAxis yAxisId="left" tick={{ fontSize: 9, fill: '#ca8a04' }} domain={['auto', 'auto']}
              tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9, fill: '#888' }} domain={['auto', 'auto']}
              tickFormatter={v => `${v.toFixed(0)}¢`} />
            <Tooltip
              contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 11 }}
              formatter={(val, name) => {
                if (name === 'btcPct') return [`${val?.toFixed(3)}%`, 'BTC %'];
                return [`${val?.toFixed(1)}¢`, name === 'upCents' ? 'Up' : 'Down'];
              }}
            />
            <Line yAxisId="left" type="monotone" dataKey="btcPct" stroke="#eab308" dot={false} strokeWidth={2} connectNulls />
            <Line yAxisId="right" type="monotone" dataKey="upCents" stroke="#22c55e" dot={false} strokeWidth={1.5} connectNulls />
            <Line yAxisId="right" type="monotone" dataKey="downCents" stroke="#ef4444" dot={false} strokeWidth={1.5} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Buy buttons */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-3 space-y-2">
        {/* Market-ish buy */}
        <div className="grid grid-cols-2 gap-2">
          {/* Up side */}
          <div className="space-y-1">
            <div className="flex gap-1 items-center justify-center">
              <button onClick={() => doBuy('up', 5, -3)} className="px-2 py-1 rounded bg-green-900 text-green-300 text-[10px] font-bold hover:bg-green-800">-3¢</button>
              <button onClick={() => doBuy('up', 5, 0)} className="px-3 py-1.5 rounded bg-green-600 text-white text-xs font-bold hover:bg-green-500">5sh Up</button>
              <button onClick={() => doBuy('up', 5, 3)} className="px-2 py-1 rounded bg-green-900 text-green-300 text-[10px] font-bold hover:bg-green-800">+3¢</button>
            </div>
          </div>
          {/* Down side */}
          <div className="space-y-1">
            <div className="flex gap-1 items-center justify-center">
              <button onClick={() => doBuy('down', 5, -3)} className="px-2 py-1 rounded bg-red-900 text-red-300 text-[10px] font-bold hover:bg-red-800">-3¢</button>
              <button onClick={() => doBuy('down', 5, 0)} className="px-3 py-1.5 rounded bg-red-600 text-white text-xs font-bold hover:bg-red-500">5sh Down</button>
              <button onClick={() => doBuy('down', 5, 3)} className="px-2 py-1 rounded bg-red-900 text-red-300 text-[10px] font-bold hover:bg-red-800">+3¢</button>
            </div>
          </div>
        </div>

        {/* Limit buttons */}
        <div className="border-t border-gray-700/50 pt-2">
          <div className="text-[10px] text-gray-500 mb-1 font-medium">Limits (5sh GTC)</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex gap-1 justify-center">
              {[-5, -3, -1].map(off => (
                <button key={off} onClick={() => doLimit('up', off)}
                  className="px-2 py-1 rounded bg-green-950 text-green-400 text-[10px] font-bold hover:bg-green-900 border border-green-800/50">
                  L&#x2191; {off}¢
                </button>
              ))}
            </div>
            <div className="flex gap-1 justify-center">
              {[-5, -3, -1].map(off => (
                <button key={off} onClick={() => doLimit('down', off)}
                  className="px-2 py-1 rounded bg-red-950 text-red-400 text-[10px] font-bold hover:bg-red-900 border border-red-800/50">
                  L&#x2193; {off}¢
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Both + 99c Winner */}
        <div className="border-t border-gray-700/50 pt-2 flex gap-2 justify-center flex-wrap">
          <button onClick={() => doBoth(-3)}
            className="px-3 py-1 rounded bg-purple-900 text-purple-300 text-[10px] font-bold hover:bg-purple-800 border border-purple-700/50">
            Both -3¢
          </button>
          <button onClick={() => doBoth(-5)}
            className="px-3 py-1 rounded bg-purple-900 text-purple-300 text-[10px] font-bold hover:bg-purple-800 border border-purple-700/50">
            Both -5¢
          </button>
          <button onClick={doLimit99}
            className="px-4 py-1.5 rounded bg-yellow-600 text-black text-xs font-extrabold hover:bg-yellow-500 border border-yellow-400/50">
            99¢ Winner
          </button>
          <button
            onClick={async () => {
              try {
                const r = await fetch(`${API_BASE}/api/btc5m/auto99/toggle`, { method: 'POST' });
                const d = await r.json();
                setAuto99(d.enabled);
              } catch {}
            }}
            className={`px-3 py-1.5 rounded text-xs font-extrabold border transition-colors ${auto99 ? 'bg-cyan-600 text-white border-cyan-400 animate-pulse' : 'bg-gray-800 text-gray-400 border-gray-600 hover:bg-gray-700'}`}
          >
            {auto99 ? 'AUTO-99 ON' : 'Auto-99'}
          </button>
        </div>

        {/* Status */}
        {buyStatus && (
          <div className={`text-center text-[11px] font-mono ${buyStatus.ok ? 'text-green-400' : 'text-red-400'}`}>
            {buyStatus.msg}
          </div>
        )}
      </div>

      {/* Positions */}
      {(upShares > 0 || downShares > 0) && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-3">
          <div className="text-xs font-bold text-gray-400 mb-1">Positions</div>
          <div className="grid grid-cols-2 gap-3 text-[11px] font-mono">
            <div>
              <span className="text-green-400">Up:</span> {upShares}sh @ {(upAvgPrice * 100).toFixed(1)}¢
              <span className="text-gray-500 ml-1">(${upCost.toFixed(2)})</span>
              <span className={`ml-1 ${upValue - upCost >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {upValue - upCost >= 0 ? '+' : ''}{((upValue - upCost) * 100).toFixed(0)}¢
              </span>
            </div>
            <div>
              <span className="text-red-400">Down:</span> {downShares}sh @ {(downAvgPrice * 100).toFixed(1)}¢
              <span className="text-gray-500 ml-1">(${downCost.toFixed(2)})</span>
              <span className={`ml-1 ${downValue - downCost >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {downValue - downCost >= 0 ? '+' : ''}{((downValue - downCost) * 100).toFixed(0)}¢
              </span>
            </div>
          </div>
          <div className={`text-xs font-bold mt-1 ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            P&L: {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
          </div>
        </div>
      )}
    </div>
  );
}
