import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

const DURATIONS = [
  { value: '', label: 'All' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
];

export default function EventSearch({ currentSlug, onClose }) {
  const [duration, setDuration] = useState('');
  const [date, setDate] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(null);

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (duration) params.set('duration', duration);
      if (date) params.set('date', date);
      if (query) params.set('q', query);
      const r = await fetch(`${API_BASE}/api/event-search?${params}`);
      const data = await r.json();
      setResults(data.events || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [duration, date, query]);

  useEffect(() => {
    const timer = setTimeout(search, query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [duration, date, query, search]);

  async function handleSelect(ev) {
    if (ev.slug === currentSlug) return;
    setSwitching(ev.slug);
    try {
      await fetch(`${API_BASE}/api/event/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: ev.slug }),
      });
      onClose?.();
    } catch (e) {
      console.error('Switch failed:', e);
    } finally {
      setSwitching(null);
    }
  }

  async function handleRefresh() {
    try {
      await fetch(`${API_BASE}/api/event/refresh`, { method: 'POST' });
      onClose?.();
    } catch {}
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-700 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-200">Find Event</h3>
        <div className="flex items-center gap-2">
          <button onClick={handleRefresh}
            className="text-xs text-orange-400 hover:text-orange-300 px-2 py-1 rounded bg-gray-800">
            Back to Auto (5m)
          </button>
          {onClose && (
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">&times;</button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        {/* Duration pills */}
        <div className="flex gap-0.5 bg-gray-800 rounded-lg p-0.5">
          {DURATIONS.map(d => (
            <button key={d.value} onClick={() => setDuration(d.value)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                duration === d.value ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}>
              {d.label}
            </button>
          ))}
        </div>

        {/* Date */}
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-gray-300" />

        {date && (
          <button onClick={() => setDate('')} className="text-xs text-gray-500 hover:text-gray-300">Clear date</button>
        )}
      </div>

      {/* Text search */}
      <input type="text" value={query} onChange={e => setQuery(e.target.value)}
        placeholder="Search by name or slug..."
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600" />

      {/* Results */}
      <div className="max-h-72 overflow-y-auto space-y-1">
        {loading && <div className="text-xs text-gray-500 py-2">Searching...</div>}
        {!loading && results.length === 0 && (
          <div className="text-xs text-gray-600 py-2">No events found</div>
        )}
        {!loading && results.length > 0 && (
          <div className="text-xs text-gray-600 pb-1">{results.length} events</div>
        )}
        {results.map(ev => {
          const isCurrent = ev.isCurrent || ev.slug === currentSlug;
          const isSwitching = switching === ev.slug;
          const dotColor = isCurrent ? 'bg-orange-400' : ev.active ? 'bg-green-400' : ev.upcoming ? 'bg-blue-400' : 'bg-gray-600';

          return (
            <button key={ev.slug} onClick={() => handleSelect(ev)} disabled={isCurrent || isSwitching}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                isCurrent
                  ? 'bg-orange-900/30 border border-orange-500/40 cursor-default'
                  : ev.active
                    ? 'bg-green-900/20 hover:bg-green-900/30 border border-transparent hover:border-green-700/50'
                    : 'bg-gray-800/50 hover:bg-gray-800 border border-transparent hover:border-gray-700'
              }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
                  <span className="text-gray-300 truncate">{ev.title}</span>
                  {ev.duration && (
                    <span className="px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 text-[10px] flex-shrink-0">
                      {ev.duration}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                  {ev.hasData && <span className="text-gray-600 text-[10px]">{ev.count} pts</span>}
                  {ev.active && !isCurrent && <span className="text-green-400 text-[10px] font-bold">LIVE</span>}
                  {ev.upcoming && <span className="text-blue-400 text-[10px]">UPCOMING</span>}
                  {isCurrent && <span className="text-orange-400 font-bold text-[10px]">CURRENT</span>}
                  {isSwitching && <span className="text-blue-400 text-[10px] animate-pulse">Switching...</span>}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
