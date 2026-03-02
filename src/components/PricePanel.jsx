import React from 'react';

function PriceTile({ label, price, color }) {
  return (
    <div className={`flex-1 rounded-xl p-4 border ${color} text-center`}>
      <p className="text-xs uppercase tracking-widest text-gray-400 mb-1">{label}</p>
      <p className="text-3xl font-bold font-mono">
        {price ? `${(price * 100).toFixed(1)}¢` : '—'}
      </p>
      <p className="text-xs text-gray-500 mt-1">
        {price ? `≈ ${(1 / price).toFixed(2)}x if wins` : ''}
      </p>
    </div>
  );
}

export default function PricePanel({ prices }) {
  return (
    <div className="flex gap-3">
      <PriceTile label="⬆ Up" price={prices.upPrice} color="border-green-800 bg-green-950/30 text-green-400" />
      <PriceTile label="⬇ Down" price={prices.downPrice} color="border-red-800 bg-red-950/30 text-red-400" />
    </div>
  );
}
