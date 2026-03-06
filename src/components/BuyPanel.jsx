import React from 'react';

export default function BuyPanel({ side, price, amounts, buying, onBuy, onRewardsBuy, onRewardsSell, onSuperRewards, onSuperSell, onSell, onSellAll, holdings, tokenId, expectedROI = 0, showROIHint = false }) {
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

      {/* Rewards buttons */}
      <div className="border-t border-gray-700/50 pt-2 space-y-1.5">
        <div className="text-xs text-gray-500 font-medium">Limits (50 shares, GTC)</div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            disabled={buying === `rewards-buy-${side}` || !price}
            onClick={() => onRewardsBuy(side)}
            className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
              buying === `rewards-buy-${side}` ? 'opacity-50 cursor-wait' : ''
            } ${isUp
              ? 'bg-green-800/60 hover:bg-green-700/60 border border-green-600/40 text-green-300 disabled:opacity-30'
              : 'bg-red-800/60 hover:bg-red-700/60 border border-red-600/40 text-red-300 disabled:opacity-30'
            }`}
          >
            {buying === `rewards-buy-${side}` ? '...' : `Buy +1¢`}
          </button>
          <button
            disabled={buying === `rewards-sell-${side}` || !price}
            onClick={() => onRewardsSell(side)}
            className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
              buying === `rewards-sell-${side}` ? 'opacity-50 cursor-wait' : ''
            } ${isUp
              ? 'bg-green-800/60 hover:bg-green-700/60 border border-green-600/40 text-green-300 disabled:opacity-30'
              : 'bg-red-800/60 hover:bg-red-700/60 border border-red-600/40 text-red-300 disabled:opacity-30'
            }`}
          >
            {buying === `rewards-sell-${side}` ? '...' : `Sell -1¢`}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            disabled={buying === `super-${side}` || !price}
            onClick={() => onSuperRewards(side)}
            className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
              buying === `super-${side}` ? 'opacity-50 cursor-wait' : ''
            } bg-yellow-700/40 hover:bg-yellow-600/40 border border-yellow-500/40 text-yellow-300 disabled:opacity-30`}
          >
            {buying === `super-${side}` ? '...' : `Buy 50 (-1¢)`}
          </button>
          <button
            disabled={buying === `super-sell-${side}` || !price}
            onClick={() => onSuperSell(side)}
            className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
              buying === `super-sell-${side}` ? 'opacity-50 cursor-wait' : ''
            } bg-yellow-700/40 hover:bg-yellow-600/40 border border-yellow-500/40 text-yellow-300 disabled:opacity-30`}
          >
            {buying === `super-sell-${side}` ? '...' : `Sell 50 (+1¢)`}
          </button>
        </div>
      </div>

      {/* Sell buttons */}
      {holdings && holdings[side]?.shares >= 5 && (
        <div className="border-t border-gray-700/50 pt-2 space-y-1.5">
          {holdings[side].shares >= 25 && (
            <button
              disabled={buying === `sell-${side}` || !price}
              onClick={() => onSell(side, 25, price)}
              className={`w-full py-2 rounded-lg text-sm font-bold transition-all ${
                buying === `sell-${side}` ? 'opacity-50 cursor-wait' : ''
              } bg-orange-700/40 hover:bg-orange-600/40 border border-orange-500/40 text-orange-300 disabled:opacity-30`}
            >
              {buying === `sell-${side}` ? '...' : `Sell 25 ${isUp ? 'UP' : 'DOWN'}`}
            </button>
          )}
          <button
            disabled={buying === `sellall-${side}` || !price}
            onClick={() => onSellAll(side, tokenId)}
            className={`w-full py-2 rounded-lg text-sm font-bold transition-all ${
              buying === `sellall-${side}` ? 'opacity-50 cursor-wait' : ''
            } bg-red-700/50 hover:bg-red-600/50 border border-red-500/50 text-red-300 disabled:opacity-30`}
          >
            {buying === `sellall-${side}` ? '...' : `Sell All ${isUp ? 'UP' : 'DOWN'} (-1¢)`}
          </button>
        </div>
      )}
    </div>
  );
}
