import React from 'react';

function PriceTile({ label, price, startPrice, color }) {
  const diff = price && startPrice ? price - startPrice : null;
  const diffPct = diff != null && startPrice ? (diff / startPrice) * 100 : null;

  return (
    <div className={`flex-1 rounded-xl p-4 border ${color} text-center`}>
      <p className="text-xs uppercase tracking-widest text-gray-400 mb-1">{label}</p>
      <p className="text-3xl font-bold font-mono">
        {price ? `${(price * 100).toFixed(1)}¢` : '—'}
      </p>
      {startPrice != null && (
        <p className="text-xs text-gray-500 mt-1">
          Start {(startPrice * 100).toFixed(1)}¢
          {diff != null && (
            <span className={`ml-1 font-mono ${diff >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              ({diff >= 0 ? '+' : ''}{(diff * 100).toFixed(1)}¢)
            </span>
          )}
        </p>
      )}
      <p className="text-xs text-gray-500 mt-0.5">
        {price ? `${(1 / price).toFixed(2)}x if wins` : ''}
      </p>
    </div>
  );
}

export default function PricePanel({ prices }) {
  return (
    <div className="flex gap-3">
      <PriceTile
        label="UP"
        price={prices.upPrice}
        startPrice={prices.upStartPrice}
        color="border-green-800 bg-green-950/30 text-green-400"
      />
      <PriceTile
        label="DOWN"
        price={prices.downPrice}
        startPrice={prices.downStartPrice}
        color="border-red-800 bg-red-950/30 text-red-400"
      />
    </div>
  );
}
