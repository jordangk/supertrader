import React from 'react';

export default function BTCBar({ btc }) {
  const { current, start } = btc;
  const delta = current && start ? current - start : null;
  const deltaPct = delta && start ? (delta / start) * 100 : null;
  const isUp = delta > 0;

  return (
    <div className="bg-gray-900 rounded-xl px-4 py-3 border border-gray-800 flex items-center justify-between">
      <div>
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-0.5">Bitcoin</p>
        <p className="text-2xl font-bold font-mono text-white">
          {current ? `$${current.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
        </p>
      </div>
      <div className="text-right">
        <p className="text-xs text-gray-500 mb-0.5">Started at</p>
        <p className="text-sm font-mono text-gray-400">
          {start ? `$${start.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
        </p>
      </div>
      <div className={`text-right px-3 py-2 rounded-lg ${isUp ? 'bg-green-900/40' : 'bg-red-900/40'}`}>
        <p className={`text-xl font-bold font-mono ${isUp ? 'text-green-400' : 'text-red-400'}`}>
          {delta ? `${isUp ? '+' : ''}${delta.toFixed(2)}` : '—'}
        </p>
        <p className={`text-xs font-mono ${isUp ? 'text-green-500' : 'text-red-500'}`}>
          {deltaPct ? `${isUp ? '+' : ''}${deltaPct.toFixed(3)}%` : ''}
        </p>
      </div>
    </div>
  );
}
