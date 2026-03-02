import React from 'react';

function formatTime(secs) {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseNotes(notesStr) {
  try { return JSON.parse(notesStr); } catch { return {}; }
}

export default function OrderHistory({ orders, prices }) {
  if (!orders.length) return (
    <div className="text-center text-gray-600 text-sm py-4">No trades yet this session.</div>
  );

  const upNow = prices?.upPrice;
  const downNow = prices?.downPrice;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-400">Recent Orders</h3>
        <div className="flex gap-3 text-xs font-mono">
          <span className="text-gray-500">Now:</span>
          <span className="text-green-400">UP {upNow ? `${(upNow * 100).toFixed(1)}¢` : '—'}</span>
          <span className="text-red-400">DN {downNow ? `${(downNow * 100).toFixed(1)}¢` : '—'}</span>
        </div>
      </div>
      <div className="overflow-x-auto max-h-80 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800">
              <th className="px-3 py-2 text-left">Side</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-right">Buy Price</th>
              <th className="px-3 py-2 text-right">Shares</th>
              <th className="px-3 py-2 text-right">Up @Buy</th>
              <th className="px-3 py-2 text-right">Dn @Buy</th>
              <th className="px-3 py-2 text-right">Cur Value</th>
              <th className="px-3 py-2 text-right">Time Left</th>
              <th className="px-3 py-2 text-right">BTC</th>
              <th className="px-3 py-2 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {orders.map(o => {
              const isUp = o.direction === 'up';
              const notes = parseNotes(o.notes);
              const upAtBuy = notes.upPriceAtBuy;
              const downAtBuy = notes.downPriceAtBuy;
              const timeLeft = notes.timeLeftSecs;
              const pl = o.profit_loss;
              const sharesNum = parseFloat(o.shares || 0);
              const currentPrice = isUp ? upNow : downNow;
              const currentValue = currentPrice != null ? sharesNum * currentPrice : null;
              const cost = parseFloat(o.purchase_amount || 0);
              const pnl = currentValue != null ? currentValue - cost : null;

              return (
                <tr key={o.id} className="hover:bg-gray-800/40 transition-colors">
                  <td className="px-3 py-2">
                    <span className={`font-bold ${isUp ? 'text-green-400' : 'text-red-400'}`}>
                      {isUp ? '↑ UP' : '↓ DN'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-300">
                    ${cost.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-300">
                    {(parseFloat(o.purchase_price) * 100).toFixed(1)}¢
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-300">
                    {sharesNum.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-green-400/70">
                    {upAtBuy != null ? `${(upAtBuy * 100).toFixed(1)}¢` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-red-400/70">
                    {downAtBuy != null ? `${(downAtBuy * 100).toFixed(1)}¢` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {currentValue != null && o.order_status !== 'resolved' ? (
                      <div>
                        <span className="font-mono text-white">${currentValue.toFixed(2)}</span>
                        <span className={`ml-1 font-mono text-[10px] ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                        </span>
                      </div>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-400">
                    {formatTime(timeLeft)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-orange-300/70">
                    {o.btc_price_at_purchase
                      ? `$${parseFloat(o.btc_price_at_purchase).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {o.order_status === 'resolved' ? (
                      <span className={`font-mono font-bold ${pl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {pl > 0 ? '+' : ''}${parseFloat(pl).toFixed(2)}
                      </span>
                    ) : (
                      <span className={`text-[10px] uppercase tracking-wide ${
                        o.order_status === 'filled' ? 'text-blue-400' : 'text-gray-600'
                      }`}>{o.order_status}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
