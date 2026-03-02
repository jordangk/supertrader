import React from 'react';

export default function Positions({ orders, prices }) {
  // Aggregate positions for current event from today's orders
  const positions = {};

  for (const o of orders) {
    if (o.order_status === 'resolved') continue; // skip resolved
    const side = o.direction; // 'up' or 'down'
    if (!positions[side]) {
      positions[side] = { qty: 0, totalCost: 0, totalShares: 0 };
    }
    positions[side].totalCost += parseFloat(o.purchase_amount || 0);
    positions[side].totalShares += parseFloat(o.shares || 0);
    positions[side].qty += 1;
  }

  const rows = Object.entries(positions).filter(([, p]) => p.totalShares > 0);
  if (!rows.length) return null;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">Positions</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
            <th className="px-4 py-2 text-left">Outcome</th>
            <th className="px-4 py-2 text-right">Qty</th>
            <th className="px-4 py-2 text-right">Avg</th>
            <th className="px-4 py-2 text-right">Value</th>
            <th className="px-4 py-2 text-right">Return</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {rows.map(([side, pos]) => {
            const isUp = side === 'up';
            const avgPrice = pos.totalCost / pos.totalShares;
            const currentPrice = isUp ? prices.upPrice : prices.downPrice;
            const value = currentPrice ? pos.totalShares * currentPrice : null;
            const returnAmt = value !== null ? value - pos.totalCost : null;
            const returnPct = returnAmt !== null ? (returnAmt / pos.totalCost) * 100 : null;
            const isProfit = returnAmt > 0;

            return (
              <tr key={side} className="hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-3">
                  <span className={`font-semibold ${isUp ? 'text-green-400' : 'text-red-400'}`}>
                    {isUp ? '⬆ Up' : '⬇ Down'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono text-gray-300">
                  {pos.totalShares.toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-gray-300">
                  {(avgPrice * 100).toFixed(1)}¢
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="font-mono font-semibold text-white">
                    {value !== null ? `$${value.toFixed(2)}` : '—'}
                  </div>
                  <div className="text-xs text-gray-500">Cost ${pos.totalCost.toFixed(2)}</div>
                </td>
                <td className="px-4 py-3 text-right">
                  {returnAmt !== null ? (
                    <span className={`font-mono font-semibold ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
                      {isProfit ? '+' : ''}${returnAmt.toFixed(2)}{' '}
                      <span className="text-xs">({isProfit ? '+' : ''}{returnPct.toFixed(2)}%)</span>
                    </span>
                  ) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
