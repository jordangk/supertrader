import React from 'react';

export default function BuyPanel({ side, price, amounts, buying, onBuy, expectedROI = 0, showROIHint = false }) {
  const isUp = side === 'up';
  const raw = price != null ? price / (1 + expectedROI) : null;
  const threshold = raw != null ? Math.min(raw, 0.99) : null;

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${isUp ? 'border-green-800 bg-green-950/20' : 'border-red-800 bg-red-950/20'}`}>
      <div className="flex items-center justify-between">
        <h3 className={`font-bold text-lg ${isUp ? 'text-green-400' : 'text-red-400'}`}>
          {isUp ? 'UP' : 'DOWN'}
        </h3>
        <span className={`text-sm font-mono font-bold ${isUp ? 'text-green-300' : 'text-red-300'}`}>
          {price ? `${(price * 100).toFixed(1)}¢` : '—'}
        </span>
      </div>
      {threshold != null && showROIHint && (
        <p className={`text-xs ${isUp ? 'text-green-400/80' : 'text-red-400/80'}`}>
          Buy below {(threshold * 100).toFixed(1)}¢ to increase expected ROI
        </p>
      )}

      <div className="grid grid-cols-3 gap-1.5">
        {amounts.map(amt => {
          const isBuying = buying === `${side}-${amt}`;
          return (
            <button
              key={amt}
              disabled={isBuying || !price}
              onClick={() => onBuy(side, amt)}
              className={`
                py-2 rounded-lg text-sm font-bold transition-all
                ${isBuying ? 'opacity-50 cursor-wait' : ''}
                ${isUp
                  ? 'bg-green-600 hover:bg-green-500 active:bg-green-700 text-white disabled:opacity-30'
                  : 'bg-red-600 hover:bg-red-500 active:bg-red-700 text-white disabled:opacity-30'
                }
              `}
            >
              {isBuying ? '...' : `$${amt}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}
