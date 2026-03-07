import React, { useState, useEffect } from 'react';

// In dev, use relative URL so Vite proxy (/api → :3001) works; avoids CORS
const API_BASE = import.meta.env.DEV
  ? ''
  : ((import.meta.env.VITE_API_URL || '').replace(/\/$/, '') ||
      (typeof window !== 'undefined' ? `http://${window.location.hostname}:3001` : ''));

function apiUrl(path) {
  const base = API_BASE || '';
  return `${base}/api${path}`.replace(/\/+/g, '/');
}

async function fetchWithTimeout(url, opts = {}, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

const PCT_OPTIONS = [
  { value: 0.01, label: '1%' },
  { value: 0.02, label: '2%' },
  { value: 0.05, label: '5%' },
  { value: 0.10, label: '10%' },
  { value: 0.50, label: '50%' },
];

const EVENT_TIME_OPTIONS = [
  { value: '', label: 'All' },
  // { value: '5m', label: '5m' },
  // { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
];

const BATCH_OPTIONS = [
  { value: '1s', label: '1s (every second)' },
];

const ORDER_TYPE_OPTIONS = [
  { value: 'FAK', label: 'FAK' },
  { value: 'GTC', label: 'GTC' },
];

function getSimMode(pct, batchMode) {
  const base = { 0.01: '1pct', 0.02: '2pct', 0.05: '5pct', 0.10: '10pct', 0.50: '50pct' }[pct] || '1pct';
  return batchMode === 'cum50' ? `${base}_070` : `${base}_070_min5`;
}

function usd(n) { return '$' + (n ?? 0).toFixed(2); }

function parseSlugTime(slug) {
  const parts = slug.split('-');
  const epoch = parseInt(parts[parts.length - 1], 10);
  if (isNaN(epoch)) return slug;
  return new Date(epoch * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function slugMatchesDuration(slug, duration) {
  if (!duration || !slug) return true;
  if (duration === '5m') return slug.includes('-5m-') || slug.startsWith('btc-updown-5m');
  if (duration === '15m') return slug.includes('-15m-') || slug.startsWith('btc-updown-15m');
  if (duration === '1h') return slug.startsWith('bitcoin-up-or-down-');
  return true;
}

export default function LiveBetsConfig({ copyFeed = [] }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingAction, setSavingAction] = useState(null); // 'save' | 'disable' | 'enable'
  const [testLoading, setTestLoading] = useState(false);
  const [testResults, setTestResults] = useState([]);
  const [testNote, setTestNote] = useState('');
  const [error, setError] = useState(null);
  const [pct, setPct] = useState(0.01);
  const [eventTime, setEventTime] = useState('');
  const [batchMode, setBatchMode] = useState('1s');
  const [orderType, setOrderType] = useState('FAK');
  const [hasChanges, setHasChanges] = useState(false);

  function errMsg(e) {
    return e?.name === 'AbortError' || /aborted/i.test(e?.message || '') ? 'Request timed out — try again.' : (e?.message || 'Unknown error');
  }

  async function fetchStatus() {
    try {
      const bases = API_BASE ? [API_BASE, ''] : [''];
      let lastErr = null;
      for (const base of bases) {
        const url = `${base || '/'}/api/k9-copy/status`.replace(/\/+/g, '/');
        try {
          const r = await fetch(url);
          const d = await r.json();
          setStatus(d);
          setPct(d.pct ?? 0.01);
          setEventTime(d.eventTime ?? '');
          setBatchMode(d.batchMode ?? '1s');
          setOrderType(d.orderType ?? 'FAK');
          setHasChanges(false);
          setError(null);
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      const msg = lastErr?.message === 'Failed to fetch'
        ? 'Cannot reach server. Is it running on port 3001?'
        : (lastErr?.name === 'AbortError' || /aborted/i.test(lastErr?.message || '') ? 'Request timed out — try again.' : (lastErr?.message || 'Unknown error'));
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
    // Auto-refresh every 5s to keep log current
    const iv = setInterval(fetchStatus, 5000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!status) return;
    setHasChanges(
      (pct !== (status.pct ?? 0.01)) ||
      (eventTime !== (status.eventTime ?? '')) ||
      (batchMode !== (status.batchMode ?? '1s')) ||
      (orderType !== (status.orderType ?? 'FAK'))
    );
  }, [pct, eventTime, batchMode, status]);

  async function handleSave() {
    if (!hasChanges) return;
    setSaving(true);
    setSavingAction('save');
    setError(null);
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/k9-copy/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pct, eventTime: eventTime || undefined, batchMode, orderType }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to save');
      await fetchStatus();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
      setSavingAction(null);
    }
  }

  async function handleResetStuck() {
    setError(null);
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/k9-copy/reset-stuck`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to reset');
      await fetchStatus();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function handleDisable() {
    setSaving(true);
    setSavingAction('disable');
    setError(null);
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/k9-copy/stop`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to disable');
      await fetchStatus();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
      setSavingAction(null);
    }
  }

  async function handleEnable() {
    setSaving(true);
    setSavingAction('enable');
    setError(null);
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/k9-copy/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pct, eventTime: eventTime || undefined, batchMode, orderType }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to enable');
      await fetchStatus();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
      setSavingAction(null);
    }
  }

  async function handleTest() {
    setTestLoading(true);
    setError(null);
    try {
      const base = API_BASE || (typeof window !== 'undefined' ? `http://${window.location.hostname}:3001` : '');
      const params = new URLSearchParams({ limit: '15' });
      if (eventTime) params.set('duration', eventTime);
      const r = await fetch(`${base}/api/sim-dashboard?${params}`);
      const d = await r.json();
      const events = Array.isArray(d?.events) ? d.events : [];
      const mode = getSimMode(pct, batchMode);
      // Sort by epoch desc (most recent first)
      const byEpoch = (ev) => {
        const m = ev.slug?.match(/(\d{10,})/);
        return m ? parseInt(m[1], 10) : 0;
      };
      const sorted = [...events].sort((a, b) => byEpoch(b) - byEpoch(a));
      // Filter by event time — match server logic: 5m/15m use slug patterns, 1h = bitcoin-up-or-down-*
      const matchesEventTime = (slug) => {
        if (!eventTime || !slug) return true;
        if (eventTime === '1h') return slug.startsWith('bitcoin-up-or-down-');
        if (eventTime === '5m') return slug.includes('-5m-') || slug.startsWith('btc-updown-5m');
        if (eventTime === '15m') return slug.includes('-15m-') || slug.startsWith('btc-updown-15m');
        return true;
      };
      let filtered = eventTime ? sorted.filter(ev => matchesEventTime(ev.slug)) : sorted;
      const matchedCount = filtered.length;
      let usedFallback = false;
      if (filtered.length < 10) {
        usedFallback = !!eventTime;
        filtered = sorted.slice(0, 10); // fallback: use all timeframes, most recent first
      } else {
        filtered = filtered.slice(0, 10);
      }
      const shown = filtered.length;
      setTestNote(usedFallback
        ? `${matchedCount} event${matchedCount === 1 ? '' : 's'} match ${eventTime}. Showing ${shown} most recent (all timeframes)${shown < 10 ? ' — that\'s all available' : ''}.`
        : '');
      let results = filtered.map(ev => {
        const sm = ev.sim?.[mode];
        const res = ev.resolution;
        let pnl = null;
        let resolved = false;
        const cost = sm?.totalCost ?? 0;
        const realized = sm?.totalRealized ?? 0;
        if (res?.closed && res?.winner && sm) {
          resolved = true;
          const payout = res.winner === 'Up' ? (sm.Up?.shares ?? 0) : (sm.Down?.shares ?? 0);
          pnl = payout - cost + realized;
        }
        const triggerCount = sm?.triggerCount ?? 0;
        return {
          slug: ev.slug,
          timeLabel: parseSlugTime(ev.slug),
          pnl,
          resolved,
          cost,
          triggerCount,
          placeholder: false,
        };
      });
      // Always show 10 rows (pad with placeholders if fewer events)
      while (results.length < 10) {
        results = [...results, { slug: '', timeLabel: '—', pnl: null, resolved: false, cost: 0, triggerCount: 0, placeholder: true }];
      }
      setTestResults(results);
    } catch (e) {
      setError(errMsg(e));
      setTestResults([]);
      setTestNote('');
    } finally {
      setTestLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-gray-500 text-sm">
        Loading live bets config…
      </div>
    );
  }

  const enabled = status?.enabled ?? false;
  const eventTimeLabel = EVENT_TIME_OPTIONS.find(o => o.value === eventTime)?.label || 'All';

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200">Live Bets (k9 Copy)</h3>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-mono px-2 py-0.5 rounded ${enabled ? 'bg-green-900/50 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
            {enabled ? `ON · ${status?.pct != null ? Math.round(status.pct * 100) : '?'}%` : 'OFF'}
          </span>
          {enabled && status?.stats && (
            <span className="text-xs text-gray-500">
              {status.stats.buys || 0} buys · {status.stats.sells || 0} sells
              {status.stats.errors > 0 && <span className="text-red-400 ml-1">· {status.stats.errors} errors</span>}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-950/30 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button onClick={() => { setError(null); fetchStatus(); }} className="text-cyan-400 hover:text-cyan-300 shrink-0">Retry</button>
        </div>
      )}

      <div className="flex flex-wrap gap-4 items-end">
        {/* % selector */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Copy %</div>
          <div className="flex gap-0.5 bg-gray-800 rounded-lg p-0.5">
            {PCT_OPTIONS.map(o => (
              <button
                key={o.value}
                onClick={() => setPct(o.value)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  pct === o.value ? 'bg-orange-500 text-white font-bold' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Batch mode selector */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Batch</div>
          <div className="flex gap-0.5 bg-gray-800 rounded-lg p-0.5">
            {BATCH_OPTIONS.map(o => (
              <button
                key={o.value}
                onClick={() => setBatchMode(o.value)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  batchMode === o.value ? 'bg-orange-500 text-white font-bold' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Order type selector */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Order Type</div>
          <div className="flex gap-0.5 bg-gray-800 rounded-lg p-0.5">
            {ORDER_TYPE_OPTIONS.map(o => (
              <button
                key={o.value}
                onClick={() => setOrderType(o.value)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  orderType === o.value ? 'bg-orange-500 text-white font-bold' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Event time selector */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Event Time</div>
          <div className="flex gap-0.5 bg-gray-800 rounded-lg p-0.5">
            {EVENT_TIME_OPTIONS.map(o => (
              <button
                key={o.value || 'all'}
                onClick={() => setEventTime(o.value)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  eventTime === o.value ? 'bg-orange-500 text-white font-bold' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 items-center">
          <button
            onClick={handleTest}
            disabled={testLoading}
            className="px-3 py-1.5 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg disabled:opacity-50"
          >
            {testLoading ? 'Testing…' : 'Test'}
          </button>
          {enabled ? (
            <>
              {hasChanges && (
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs font-medium bg-orange-500 hover:bg-orange-600 text-white rounded-lg disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              )}
              <button
                onClick={handleDisable}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg disabled:opacity-50"
              >
                {saving && savingAction === 'disable' ? 'Disabling…' : 'Disable'}
              </button>
            </>
          ) : (
            <button
              onClick={handleEnable}
              disabled={saving}
              className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-500 text-white rounded-lg disabled:opacity-50"
            >
              {saving ? 'Enabling…' : 'Enable'}
            </button>
          )}
        </div>
      </div>

      {enabled && (
        <div className="text-[10px] text-gray-500">
          Copying {pct * 100}% of k9 trades · {orderType} · Events: {eventTimeLabel}
        </div>
      )}

      {/* Live feed: k9 trades + our copy orders */}
      {enabled && copyFeed.length > 0 && (() => {
        // Group entries by second
        const grouped = {};
        for (const entry of copyFeed) {
          const sec = Math.floor((entry.ts || 0) / 1000);
          if (!grouped[sec]) grouped[sec] = { ts: sec * 1000, k9: [], us: [] };
          grouped[sec][entry.who === 'k9' ? 'k9' : 'us'].push(entry);
        }
        const seconds = Object.values(grouped).sort((a, b) => b.ts - a.ts).slice(0, 30);
        return (
          <div className="border-t border-gray-800 pt-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Activity (per second)</div>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {seconds.map((sec) => {
                const time = new Date(sec.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                const k9Buys = sec.k9.filter(e => e.side === 'buy');
                const k9Sells = sec.k9.filter(e => e.side === 'sell');
                const usBuys = sec.us.filter(e => e.side === 'buy' && !e.error);
                const usSells = sec.us.filter(e => e.side === 'sell' && !e.error);
                const usErrors = sec.us.filter(e => e.error);
                const sumShares = (arr) => arr.reduce((s, e) => s + (e.shares || 0), 0);
                const sumUsdc = (arr) => arr.reduce((s, e) => s + (e.usdc || 0), 0);
                const avgPrice = (arr) => { const sh = sumShares(arr); return sh > 0 ? sumUsdc(arr) / sh : 0; };
                const errMsgs = usErrors.map(e => e.error).filter(Boolean);
                return (
                  <div key={sec.ts} className="bg-gray-800/40 rounded px-2 py-1">
                    <div className="flex items-center gap-2 text-[10px] font-mono">
                      <span className="text-gray-500 w-14 shrink-0">{time}</span>
                      {/* k9 summary */}
                      <span className="text-purple-400 font-bold">k9</span>
                      {k9Buys.length > 0 && (
                        <span className="text-green-400">
                          {k9Buys.length}B {sumShares(k9Buys).toFixed(1)}sh @{avgPrice(k9Buys).toFixed(2)}
                          {sumUsdc(k9Buys) > 0 && <span className="text-gray-500 ml-0.5">${sumUsdc(k9Buys).toFixed(2)}</span>}
                        </span>
                      )}
                      {k9Sells.length > 0 && (
                        <span className="text-red-400">
                          {k9Sells.length}S {sumShares(k9Sells).toFixed(1)}sh @{avgPrice(k9Sells).toFixed(2)}
                        </span>
                      )}
                      {sec.k9.length === 0 && <span className="text-gray-600">—</span>}
                      <span className="text-gray-700">│</span>
                      {/* our copy summary */}
                      <span className="text-cyan-400 font-bold">US</span>
                      {usBuys.length > 0 && (
                        <span className="text-green-400">
                          {usBuys.length}B {sumShares(usBuys).toFixed(1)}sh @{avgPrice(usBuys).toFixed(2)}
                        </span>
                      )}
                      {usSells.length > 0 && (
                        <span className="text-red-400">
                          {usSells.length}S {sumShares(usSells).toFixed(1)}sh @{avgPrice(usSells).toFixed(2)}
                        </span>
                      )}
                      {usErrors.length > 0 && (
                        <span className="text-red-400 relative group cursor-help">
                          {usErrors.length} err
                          <span className="hidden group-hover:block absolute bottom-full left-0 mb-1 z-50 bg-gray-900 border border-red-800 rounded px-2 py-1 text-[9px] text-red-300 whitespace-pre-wrap max-w-64 shadow-lg">
                            {errMsgs.join('\n')}
                          </span>
                        </span>
                      )}
                      {sec.us.length === 0 && <span className="text-gray-600">—</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {testResults.length > 0 && (
        <div className="border-t border-gray-800 pt-4">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Last 10 PnL (if we followed)</div>
          {testNote && (
            <div className="text-[10px] text-amber-500/90 mb-2">{testNote}</div>
          )}
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {testResults.map((r, i) => (
              <div key={i} className="flex items-center justify-between text-xs font-mono py-1 border-b border-gray-800/50">
                <span className="text-gray-400 truncate max-w-32">{r.timeLabel || r.time || r.slug || '—'}</span>
                {r.placeholder ? (
                  <span className="text-gray-600">—</span>
                ) : r.error ? (
                  <span className="text-red-400">{r.error}</span>
                ) : r.resolved && r.pnl != null ? (
                  <span className={r.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                    {r.pnl >= 0 ? '+' : ''}{usd(r.pnl)}
                  </span>
                ) : r.cost === 0 && r.triggerCount === 0 ? (
                  <span className="text-gray-500">no triggers</span>
                ) : (
                  <span className="text-gray-500">cost {usd(r.cost)} · pending</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
