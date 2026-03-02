import React from 'react';

export default function Positions({ orders, prices }) {
  // Always aggregate both sides
  const holdings = {
    up: { shares: 0, cost: 0 },
    down: { shares: 0, cost: 0 },
  };

  for (const o of orders) {
    if (o.order_status === 'resolved') continue;
    const s = o.direction;
    if (holdings[s]) {
      holdings[s].shares += parseFloat(o.shares || 0);
      holdings[s].cost += parseFloat(o.purchase_amount || 0);
    }
  }

  const totalCost = holdings.up.cost + holdings.down.cost;

  // If UP wins: up shares pay $1 each, down shares = $0
  const payoutIfUpWins = holdings.up.shares * 1.0;
  const plIfUpWins = payoutIfUpWins - totalCost;

  // If DOWN wins: down shares pay $1 each, up shares = $0
  const payoutIfDownWins = holdings.down.shares * 1.0;
  const plIfDownWins = payoutIfDownWins - totalCost;

  // Current value based on live prices
  const upValue = prices.upPrice != null ? holdings.up.shares * prices.upPrice : null;
  const downValue = prices.downPrice != null ? holdings.down.shares * prices.downPrice : null;
  const totalValue = upValue != null && downValue != null ? upValue + downValue : null;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">Holdings</h3>
        <div className="flex items-center gap-3 text-xs font-mono">
          <span className="text-gray-500">Invested</span>
          <span className="text-white font-bold">${totalCost.toFixed(2)}</span>
          {totalValue != null && (
            <>
              <span className="text-gray-600">|</span>
              <span className="text-gray-500">Value</span>
              <span className={`font-bold ${totalValue >= totalCost ? 'text-green-400' : 'text-red-400'}`}>
                ${totalValue.toFixed(2)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Holdings row */}
      <div className="grid grid-cols-2 divide-x divide-gray-800">
        {/* UP */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-green-400 font-bold text-sm">UP</span>
            <span className="font-mono text-white text-sm font-bold">
              {holdings.up.shares.toFixed(2)} <span className="text-xs text-gray-500">sh</span>
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>Cost ${holdings.up.cost.toFixed(2)}</span>
            {upValue != null && (
              <span className="font-mono">
                Val <span className="text-white">${upValue.toFixed(2)}</span>
              </span>
            )}
          </div>
        </div>
        {/* DOWN */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-red-400 font-bold text-sm">DOWN</span>
            <span className="font-mono text-white text-sm font-bold">
              {holdings.down.shares.toFixed(2)} <span className="text-xs text-gray-500">sh</span>
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>Cost ${holdings.down.cost.toFixed(2)}</span>
            {downValue != null && (
              <span className="font-mono">
                Val <span className="text-white">${downValue.toFixed(2)}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Expected outcomes */}
      <div className="border-t border-gray-800 grid grid-cols-2 divide-x divide-gray-800">
        <div className="px-4 py-2.5 text-center">
          <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">If UP wins</p>
          <p className={`font-mono font-bold text-sm ${plIfUpWins >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {plIfUpWins >= 0 ? '+' : ''}${plIfUpWins.toFixed(2)}
          </p>
          <p className="text-[10px] text-gray-600 font-mono">Payout ${payoutIfUpWins.toFixed(2)}</p>
        </div>
        <div className="px-4 py-2.5 text-center">
          <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">If DOWN wins</p>
          <p className={`font-mono font-bold text-sm ${plIfDownWins >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {plIfDownWins >= 0 ? '+' : ''}${plIfDownWins.toFixed(2)}
          </p>
          <p className="text-[10px] text-gray-600 font-mono">Payout ${payoutIfDownWins.toFixed(2)}</p>
        </div>
      </div>
    </div>
  );
}
