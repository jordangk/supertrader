import React from 'react';

export default function EventHeader({ event }) {
  if (!event) return (
    <div className="bg-gray-900 rounded-xl p-4 animate-pulse">
      <div className="h-4 bg-gray-700 rounded w-3/4 mb-2" />
      <div className="h-3 bg-gray-800 rounded w-1/2" />
    </div>
  );

  const end = event.endDate ? new Date(event.endDate) : null;
  const now = new Date();
  const secsLeft = end ? Math.max(0, Math.floor((end - now) / 1000)) : null;
  const mins = secsLeft !== null ? Math.floor(secsLeft / 60) : '?';
  const secs = secsLeft !== null ? secsLeft % 60 : '?';

  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          <span className="text-sm font-semibold text-gray-100">{event.title || 'Bitcoin Up or Down – 5m'}</span>
        </div>
        {secsLeft !== null && (
          <span className={`text-sm font-mono font-bold ${secsLeft < 60 ? 'text-red-400' : 'text-gray-400'}`}>
            {String(mins).padStart(2,'0')}:{String(secs).padStart(2,'0')}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mt-1">{event.slug}</p>
    </div>
  );
}
