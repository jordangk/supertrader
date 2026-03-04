import React, { useState, useEffect } from 'react';

export default function LimitOrderPanel({ prices, buying, onBuy, onBuyBoth, onSellBoth, openOrders, onCancel, postAction, onSetPostAction }) {
  const [side, setSide] = useState('up');
  const [priceCents, setPriceCents] = useState('');
  const [amount, setAmount] = useState('');
  const [cancelling, setCancelling] = useState(null);

  // Pre-fill price when side changes or first price arrives
  const livePrice = side === 'up' ? prices.upPrice : prices.downPrice;
  useEffect(() => {
    if (livePrice != null && priceCents === '') {
      setPriceCents((livePrice * 100).toFixed(1));
    }
  }, [livePrice != null]);

  function handleSideChange(s) {
    setSide(s);
    const p = s === 'up' ? prices.upPrice : prices.downPrice;
    if (p != null) setPriceCents((p * 100).toFixed(1));
  }

  function handleSubmit() {
    const cents = parseFloat(priceCents);
    const dollars = parseFloat(amount);
    if (!cents || cents <= 0 || cents >= 100) return;
    if (!dollars || dollars <= 0) return;
    onBuy(side, dollars, cents / 100);
  }

  async function handleCancel(orderId) {
    setCancelling(orderId);
    await onCancel(orderId);
    setCancelling(null);
  }

  const isBuying = buying === `limit-${side}`;
  const isUp = side === 'up';

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900/80 px-4 py-3 space-y-2">
      {/* Input row */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Side toggle */}
        <div className="flex rounded-lg overflow-hidden border border-gray-700">
          <button
            onClick={() => handleSideChange('up')}
            className={`px-3 py-1.5 text-xs font-bold transition-colors ${
              isUp ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >UP</button>
          <button
            onClick={() => handleSideChange('down')}
            className={`px-3 py-1.5 text-xs font-bold transition-colors ${
              !isUp ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >DOWN</button>
        </div>

        {/* Price input */}
        <div className="flex items-center gap-1">
          <input
            type="number"
            step="0.1"
            min="0.1"
            max="99.9"
            value={priceCents}
            onChange={e => setPriceCents(e.target.value)}
            placeholder="50.0"
            className="w-16 bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono text-white text-right focus:outline-none focus:border-blue-500"
          />
          <span className="text-xs text-gray-400">¢</span>
        </div>

        {/* Amount input */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-400">$</span>
          <input
            type="number"
            step="1"
            min="1"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="5"
            className="w-14 bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono text-white text-right focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={isBuying || !priceCents || !amount}
          className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-all ${
            isUp
              ? 'bg-green-600 hover:bg-green-500 active:bg-green-700 text-white disabled:opacity-30'
              : 'bg-red-600 hover:bg-red-500 active:bg-red-700 text-white disabled:opacity-30'
          }`}
        >
          {isBuying ? '...' : 'Limit'}
        </button>

        {/* Buy Both button — uses amount input or defaults to $10 */}
        <button
          onClick={() => onBuyBoth(10)}
          disabled={buying === 'both'}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white transition-all disabled:opacity-30"
        >
          {buying === 'both' ? '...' : 'Both $10'}
        </button>

        {/* Sell Both button — buy equal shares at market, sell at +3¢ */}
        <button
          onClick={() => onSellBoth(10)}
          disabled={buying === 'sellboth'}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-yellow-600 hover:bg-yellow-500 active:bg-yellow-700 text-white transition-all disabled:opacity-30"
        >
          {buying === 'sellboth' ? '...' : 'Sell Both $10'}
        </button>

        {/* Live price hint */}
        {livePrice != null && (
          <span className="text-[10px] text-gray-500">
            Mkt {(livePrice * 100).toFixed(1)}¢
          </span>
        )}

        {/* Post-buy action selector */}
        <div className="ml-auto flex rounded-lg overflow-hidden border border-gray-700">
          {[
            { key: 'none', label: 'Off' },
            { key: 'trigger', label: 'Trigger' },
            { key: 'forcesell', label: 'Sell+3¢' },
          ].map(opt => (
            <button
              key={opt.key}
              onClick={() => onSetPostAction(postAction === opt.key && opt.key !== 'none' ? 'none' : opt.key)}
              className={`px-2 py-1 text-[10px] font-bold transition-colors ${
                postAction === opt.key
                  ? 'bg-blue-600/30 text-blue-300'
                  : 'bg-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Open orders list */}
      {openOrders && openOrders.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-gray-800">
          {openOrders.map(o => {
            const oSide = o.asset_id === prices.tokenUp ? 'UP' : o.asset_id === prices.tokenDown ? 'DN' : /up|yes/i.test(o.outcome) ? 'UP' : 'DN';
            const isSell = o.side === 'SELL';
            const sideColor = oSide === 'UP' ? 'text-green-400' : 'text-red-400';
            return (
              <div key={o.id} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 font-mono">
                  <span className={`font-bold ${sideColor}`}>{isSell ? 'SELL' : ''} {oSide}</span>
                  <span className="text-gray-300">{(parseFloat(o.price) * 100).toFixed(1)}¢</span>
                  <span className="text-gray-500">{parseFloat(o.original_size).toFixed(1)} sh</span>
                  {o.size_matched && parseFloat(o.size_matched) > 0 && (
                    <span className="text-blue-400">({parseFloat(o.size_matched).toFixed(1)} filled)</span>
                  )}
                </div>
                <button
                  onClick={() => handleCancel(o.id)}
                  disabled={cancelling === o.id}
                  className="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 transition-colors disabled:opacity-40"
                >
                  {cancelling === o.id ? '...' : 'Cancel'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Pending auto-sells (queued, waiting for price to hit target) */}
      {prices.pendingSells && prices.pendingSells.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-gray-800">
          <div className="text-[10px] text-yellow-500 font-bold uppercase tracking-wider">Pending Sells ({prices.pendingSells.length})</div>
          <div className="max-h-40 overflow-y-auto space-y-1">
          {prices.pendingSells.map(ps => {
            const sideColor = ps.side === 'up' ? 'text-green-400' : 'text-red-400';
            const curPrice = ps.side === 'up' ? prices.upPrice : prices.downPrice;
            const diff = curPrice != null ? (ps.targetPrice - curPrice) : null;
            return (
              <div key={ps.id} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 font-mono">
                  <span className={`font-bold text-yellow-400`}>SELL</span>
                  <span className={`font-bold ${sideColor}`}>{ps.side.toUpperCase()}</span>
                  <span className="text-gray-300">{(ps.targetPrice * 100).toFixed(1)}¢</span>
                  <span className="text-gray-500">{ps.shares.toFixed(1)} sh</span>
                  <span className="text-gray-600">bought@{(ps.buyPrice * 100).toFixed(1)}¢</span>
                  {diff != null && (
                    <span className={`text-[10px] ${diff <= 0 ? 'text-green-400' : 'text-orange-400'}`}>
                      {diff <= 0 ? 'READY' : `${(diff * 100).toFixed(1)}¢ away`}
                    </span>
                  )}
                  <span className="text-gray-700">{ps.age}s</span>
                </div>
              </div>
            );
          })}
          </div>
        </div>
      )}
    </div>
  );
}
