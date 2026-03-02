import React, { useState } from 'react';

const FEE_PCT = 0.02;

export default function BuyPanel({ side, price, amounts, buying, onBuy, calcReturns }) {
  const [hovered, setHovered] = useState(null);
  const isUp = side === 'up';
  const color = isUp ? 'green' : 'red';

  const preview = hovered !== null ? calcReturns(side, hovered) : null;

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${isUp ? 'border-green-800 bg-green-950/20' : 'border-red-800 bg-red-950/20'}`}>
      <div className="flex items-center justify-between">
        <h3 className={`font-bold text-lg ${isUp ? 'text-green-400' : 'text-red-400'}`}>
          {isUp ? '⬆ UP' : '⬇ DOWN'}
        </h3>
        <span className={`text-sm font-mono font-bold ${isUp ? 'text-green-300' : 'text-red-300'}`}>
          {price ? `${(price * 100).toFixed(1)}¢` : '—'}
        </span>
      </div>

      {/* Buy buttons */}
      <div className="grid grid-cols-3 gap-1.5">
        {amounts.map(amt => {
          const isBuying = buying === `${side}-${amt}`;
          return (
            <button
              key={amt}
              disabled={!!buying || !price}
              onMouseEnter={() => setHovered(amt)}
              onMouseLeave={() => setHovered(null)}
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

      {/* Preview on hover */}
      {preview ? (
        <div className="text-xs space-y-1 text-gray-400 border-t border-gray-700 pt-2">
          <div className="flex justify-between">
            <span>Buy price</span>
            <span className="font-mono">{(preview.buyPrice * 100).toFixed(2)}¢</span>
          </div>
          <div className="flex justify-between">
            <span>Shares</span>
            <span className="font-mono">{preview.shares.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span>Fee (~2%)</span>
            <span className="font-mono text-yellow-500">-${preview.fee.toFixed(3)}</span>
          </div>
          <div className="flex justify-between font-bold">
            <span>If {isUp ? 'Up' : 'Down'} wins</span>
            <span className={`font-mono ${preview.profit > 0 ? 'text-green-400' : 'text-red-400'}`}>
              ${preview.returnIfWin.toFixed(2)} ({preview.profit > 0 ? '+' : ''}{preview.profit.toFixed(2)})
            </span>
          </div>
          <div className="flex justify-between text-gray-600">
            <span>If {isUp ? 'Down' : 'Up'} wins</span>
            <span className="font-mono text-red-600">-${hovered?.toFixed(2)}</span>
          </div>
        </div>
      ) : (
        <div className="text-xs text-gray-600 text-center pt-1">hover a button to preview</div>
      )}
    </div>
  );
}
