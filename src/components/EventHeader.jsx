import React, { useState, useEffect } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function EventHeader({ event }) {
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!event) return (
    <div className="bg-gray-900 rounded-xl p-4 animate-pulse">
      <div className="h-4 bg-gray-700 rounded w-3/4 mb-2" />
      <div className="h-3 bg-gray-800 rounded w-1/2" />
    </div>
  );

  const end = event.endDate ? new Date(event.endDate).getTime() : null;
  const secsLeft = end ? Math.max(0, Math.floor((end - now) / 1000)) : null;
  const mins = secsLeft !== null ? Math.floor(secsLeft / 60) : '?';
  const secs = secsLeft !== null ? secsLeft % 60 : '?';
  const expired = secsLeft === 0;

  async function loadNewEvent() {
    setRefreshing(true);
    try {
      await fetch(`${API_BASE}/api/event/refresh`, { method: 'POST' });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className={`bg-gray-900 rounded-xl p-4 border ${expired ? 'border-yellow-600' : 'border-gray-800'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full animate-pulse ${expired ? 'bg-yellow-400' : 'bg-green-400'}`} />
          <a
            href={`https://polymarket.com/event/${event.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-gray-100 hover:text-blue-400 transition-colors"
          >
            {event.title || 'Bitcoin Up or Down – 5m'}
          </a>
        </div>
        <span className="flex items-center gap-2">
          {expired && (
            <button
              onClick={loadNewEvent}
              disabled={refreshing}
              className="px-2 py-1 text-xs font-semibold bg-yellow-600 hover:bg-yellow-500 text-black rounded transition-colors disabled:opacity-50"
            >
              {refreshing ? '...' : 'New event'}
            </button>
          )}
          {secsLeft !== null && (
            <span className={`text-sm font-mono font-bold ${
              expired ? 'text-yellow-400' : secsLeft < 60 ? 'text-red-400' : 'text-gray-400'
            }`}>
              {expired ? 'ENDED' : `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`}
            </span>
          )}
        </span>
      </div>
      <p className="text-xs text-gray-500 mt-1">{event.slug}</p>
    </div>
  );
}
