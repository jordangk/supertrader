import React from 'react';

export default function OrderHistory({ orders }) {
  if (!orders.length) return (
    <div className="text-center text-gray-600 text-sm py-4">No trades yet this session.</div>
  );

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-gray-400">Recent Orders</h3>
      </div>
      <div className="divide-y divide-gray-800 max-h-64 overflow-y-auto">
        {orders.map(o => {
          const isUp = o.direction === 'up';
          const won = o.won;
          const pl = o.profit_loss;
          return (
            <div key={o.id} className="px-4 py-2.5 flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${isUp ? 'bg-green-400' : 'bg-red-400'}`} />
                <span className={`font-semibold ${isUp ? 'text-green-400' : 'text-red-400'}`}>
                  {isUp ? '↑ UP' : '↓ DOWN'}
                </span>
                <span className="text-gray-400">${parseFloat(o.purchase_amount).toFixed(2)}</span>
                <span className="text-gray-600 text-xs">@ {(parseFloat(o.purchase_price) * 100).toFixed(1)}¢</span>
              </div>
              <div className="text-right">
                {o.order_status === 'resolved' ? (
                  <span className={`font-mono font-bold ${pl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {pl > 0 ? '+' : ''}${parseFloat(pl).toFixed(2)}
                  </span>
                ) : (
                  <span className="text-gray-600 text-xs">{o.order_status}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
