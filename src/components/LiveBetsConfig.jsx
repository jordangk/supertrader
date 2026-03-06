import React, { useState, useEffect } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

const PCT_OPTIONS = [
  { value: 0.01, label: '1%' },
  { value: 0.05, label: '5%' },
  { value: 0.10, label: '10%' },
  { value: 0.50, label: '50%' },
];

const EVENT_TIME_OPTIONS = [
  { value: '', label: 'All' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
];

const BATCH_OPTIONS = [
  { value: 'min5', label: 'min5 (5 units)' },
  { value: 'cum50', label: 'cum50 (50 units)' },
];

function getSimMode(pct, batchMode) {
  const base = { 0.01: '1pct', 0.05: '5pct', 0.10: '10pct', 0.50: '50pct' }[pct] || '1pct';
  return batchMode === 'cum50' ? `${base}_070` : `${base}_070_min5`;
}

function usd(n) { return '$' + (n ?? 0).toFixed(2); }

function parseSlugTime(slug) {
  const parts = slug.split('-');
  const epoch = parseInt(parts[parts.length - 1], 10);
  if (isNaN(epoch)) return slug;
  return new Date(epoch * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function LiveBetsConfig() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testResults, setTestResults] = useState([]);
  const [testNote, setTestNote] = useState('');
  const [error, setError] = useState(null);
  const [pct, setPct] = useState(0.01);
  const [eventTime, setEventTime] = useState('');
  const [batchMode, setBatchMode] = useState('min5');
  const [hasChanges, setHasChanges] = useState(false);

  async function fetchStatus() {
    try {
      const r = await fetch(`${API_BASE}/api/k9-copy/status`);
      const d = await r.json();
      setStatus(d);
      setPct(d.pct ?? 0.01);
      setEventTime(d.eventTime ?? '');
      setBatchMode(d.batchMode ?? 'min5');
      setHasChanges(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
  }, []);

  useEffect(() => {
    if (!status) return;
    setHasChanges(
      (pct !== (status.pct ?? 0.01)) ||
      (eventTime !== (status.eventTime ?? '')) ||
      (batchMode !== (status.batchMode ?? 'min5'))
    );
  }, [pct, eventTime, batchMode, status]);

  async function handleSave() {
    if (!hasChanges) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/k9-copy/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pct, eventTime: eventTime || undefined, batchMode }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to save');
      await fetchStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDisable() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/k9-copy/stop`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to disable');
      await fetchStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEnable() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/k9-copy/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pct, eventTime: eventTime || undefined, batchMode }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to enable');
      await fetchStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTestLoading(true);
    setError(null);
    try {
      const base = API_BASE || (typeof window !== 'undefined' ? `http://${window.location.hostname}:3001` : '');
      const params = new URLSearchParams({ limit: '300' });
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
      let filtered = eventTime
        ? sorted.filter(ev => ev.slug?.includes(`-${eventTime}-`) || ev.slug?.startsWith(`btc-updown-${eventTime}`))
        : sorted;
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
      setError(e.message);
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
            {enabled ? 'ON' : 'OFF'}
          </span>
          {enabled && status?.stats && (
            <span className="text-xs text-gray-500">
              {status.stats.buys || 0} buys · {status.stats.sells || 0} sells
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-950/30 rounded-lg px-3 py-2">
          {error}
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
                {saving ? '…' : 'Disable'}
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
          Copying {pct * 100}% of k9 trades · {batchMode === 'cum50' ? 'cum50 (50 units)' : 'min5 (5 units)'} · Events: {eventTimeLabel}
        </div>
      )}

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
