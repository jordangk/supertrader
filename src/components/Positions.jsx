import React from 'react';

function deriveFromOrders(orders, prices) {
  const up = { shares: 0, cost: 0 };
  const down = { shares: 0, cost: 0 };
  for (const o of orders) {
    if (o.order_status === 'resolved') continue;
    const s = o.direction;
    const sh = Number(o.shares) || 0;
    const amt = Number(o.purchase_amount) || 0;
    if (s === 'up') {
      up.shares += sh;
      up.cost += amt;
    } else if (s === 'down') {
      down.shares += sh;
      down.cost += amt;
    }
  }
  const upValue = prices?.upPrice != null ? up.shares * prices.upPrice : null;
  const downValue = prices?.downPrice != null ? down.shares * prices.downPrice : null;
  return {
    up: up.shares > 0 ? {
      outcome: 'Up',
      size: up.shares,
      avgPrice: up.cost / up.shares,
      initialValue: up.cost,
      currentValue: upValue,
      cashPnl: upValue != null ? upValue - up.cost : null,
      percentPnl: upValue != null && up.cost > 0 ? ((upValue - up.cost) / up.cost) * 100 : null,
    } : null,
    down: down.shares > 0 ? {
      outcome: 'Down',
      size: down.shares,
      avgPrice: down.cost / down.shares,
      initialValue: down.cost,
      currentValue: downValue,
      cashPnl: downValue != null ? downValue - down.cost : null,
      percentPnl: downValue != null && down.cost > 0 ? ((downValue - down.cost) / down.cost) * 100 : null,
    } : null,
  };
}

function normalizeOutcome(p) {
  const o = (p.outcome || '').toLowerCase();
  if (o === 'yes' || o === 'up') return 'Up';
  if (o === 'no' || o === 'down') return 'Down';
  return p.outcome;
}

function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export default function Positions({ positions, eventSlug, dbEventId, fallbackOrders, prices, onSell, onMerge, selling }) {
  const filtered = eventSlug ? positions.filter(p => (p.eventSlug || p.slug) === eventSlug) : [];
  let upRaw = filtered.find(p => normalizeOutcome(p) === 'Up');
  let downRaw = filtered.find(p => normalizeOutcome(p) === 'Down');
  let upPos = upRaw ? (() => {
    const size = toNum(upRaw.size ?? upRaw.shares ?? upRaw.balance);
    const initialValue = toNum(upRaw.initialValue ?? upRaw.cost);
    const avgPrice = toNum(upRaw.avgPrice ?? upRaw.averagePrice) || (size > 0 ? initialValue / size : 0);
    const curPrice = toNum(upRaw.curPrice ?? upRaw.currentPrice);
    const currentValue = toNum(upRaw.currentValue ?? upRaw.curValue)
      || (curPrice > 0 ? size * curPrice : null)
      || (prices?.upPrice != null ? size * prices.upPrice : null);
    const cashPnl = upRaw.cashPnl != null ? toNum(upRaw.cashPnl) : (currentValue != null ? currentValue - initialValue : null);
    let percentPnl = upRaw.percentPnl != null ? toNum(upRaw.percentPnl) : (initialValue > 0 && currentValue != null ? ((currentValue - initialValue) / initialValue) * 100 : null);
    if (percentPnl != null && cashPnl != null && (cashPnl < 0) !== (percentPnl < 0)) percentPnl = -percentPnl;
    return {
      outcome: 'Up',
      size,
      avgPrice,
      initialValue,
      currentValue: currentValue != null ? currentValue : initialValue,
      cashPnl,
      percentPnl,
    };
  })() : null;
  let downPos = downRaw ? (() => {
    const size = toNum(downRaw.size ?? downRaw.shares ?? downRaw.balance);
    const initialValue = toNum(downRaw.initialValue ?? downRaw.cost);
    const avgPrice = toNum(downRaw.avgPrice ?? downRaw.averagePrice) || (size > 0 ? initialValue / size : 0);
    const curPrice = toNum(downRaw.curPrice ?? downRaw.currentPrice);
    const currentValue = toNum(downRaw.currentValue ?? downRaw.curValue)
      || (curPrice > 0 ? size * curPrice : null)
      || (prices?.downPrice != null ? size * prices.downPrice : null);
    const cashPnl = downRaw.cashPnl != null ? toNum(downRaw.cashPnl) : (currentValue != null ? currentValue - initialValue : null);
    let percentPnl = downRaw.percentPnl != null ? toNum(downRaw.percentPnl) : (initialValue > 0 && currentValue != null ? ((currentValue - initialValue) / initialValue) * 100 : null);
    if (percentPnl != null && cashPnl != null && (cashPnl < 0) !== (percentPnl < 0)) percentPnl = -percentPnl;
    return {
      outcome: 'Down',
      size,
      avgPrice,
      initialValue,
      currentValue: currentValue != null ? currentValue : initialValue,
      cashPnl,
      percentPnl,
    };
  })() : null;

  const eid = dbEventId ? String(dbEventId) : null;
  const ordersForThisEvent = eid && fallbackOrders?.length
    ? fallbackOrders.filter(o => String(o.polymarket_event_id) === eid)
    : [];

  // Fill in any missing sides from orders (API may lag behind filled limit orders)
  if (ordersForThisEvent.length > 0) {
    const derived = deriveFromOrders(ordersForThisEvent, prices);
    if (!upPos && derived.up) upPos = derived.up;
    if (!downPos && derived.down) downPos = derived.down;
  }

  const totalCost = (upPos?.initialValue || 0) + (downPos?.initialValue || 0);
  const totalValue = (upPos?.currentValue ?? upPos?.initialValue ?? 0) + (downPos?.currentValue ?? downPos?.initialValue ?? 0);
  const hasData = upPos || downPos;

  const upPrice = prices?.upPrice;
  const downPrice = prices?.downPrice;
  const hasPrices = upPrice != null && downPrice != null && (upPrice > 0 || downPrice > 0);
  const upPayout = upPos?.size ?? 0;
  const downPayout = downPos?.size ?? 0;
  const expectedValue = hasData && hasPrices && totalCost > 0
    ? upPrice * upPayout + downPrice * downPayout - totalCost
    : null;
  const expectedReturnPct = expectedValue != null && totalCost > 0
    ? (expectedValue / totalCost) * 100
    : null;

  const shortfallDown = (upPayout - downPayout);
  const shortfallUp = (downPayout - upPayout);
  const hedgeDownAmount = shortfallDown > 0 && downPrice ? shortfallDown * downPrice : null;
  const hedgeUpAmount = shortfallUp > 0 && upPrice ? shortfallUp * upPrice : null;

  const upShortfall = Math.max(0, totalCost - upPayout);
  const downShortfall = Math.max(0, totalCost - downPayout);
  const needUpForProfit = upShortfall > 0 && upPrice && upPrice < 1 ? upShortfall * upPrice / (1 - upPrice) : null;
  const needDownForProfit = downShortfall > 0 && downPrice && downPrice < 1 ? downShortfall * downPrice / (1 - downPrice) : null;
  const needUpShares = upShortfall > 0 && upPrice && upPrice < 1 ? upShortfall / (1 - upPrice) : null;
  const needDownShares = downShortfall > 0 && downPrice && downPrice < 1 ? downShortfall / (1 - downPrice) : null;
  const upAvgCost = upPayout > 0 ? (upPos?.initialValue || 0) / upPayout : 0;
  const downAvgCost = downPayout > 0 ? (downPos?.initialValue || 0) / downPayout : 0;
  const maxPriceUpForLock = upShortfall > 0 && downAvgCost > 0 ? (1 - downAvgCost) : null;
  const maxPriceDownForLock = downShortfall > 0 && upAvgCost > 0 ? (1 - upAvgCost) : null;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-300">Positions</h3>
          {onMerge && upPos && downPos && upPos.size > 0 && downPos.size > 0 && (() => {
            const mergeable = Math.min(upPos.size, downPos.size);
            const merge25 = Math.ceil(mergeable * 0.25 * 100) / 100;
            return (
              <button
                onClick={() => onMerge(merge25)}
                disabled={selling === 'merge'}
                className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-40"
              >
                {selling === 'merge' ? 'Merging...' : `Merge 25% (${merge25.toFixed(1)}sh)`}
              </button>
            );
          })()}
        </div>
        <div className="flex items-center gap-3 text-xs font-mono">
          <span className="text-gray-500">Invested</span>
          <span className="text-white font-bold">${totalCost.toFixed(2)}</span>
          {totalValue > 0 && (
            <>
              <span className="text-gray-600">|</span>
              <span className="text-gray-500">Value</span>
              <span className={`font-bold ${totalValue >= totalCost ? 'text-green-400' : 'text-red-400'}`}>
                ${totalValue.toFixed(2)}
              </span>
            </>
          )}
          {expectedValue != null && (
            <>
              <span className="text-gray-600">|</span>
              <span className="text-gray-500">Expected</span>
              <span className={`font-bold ${expectedValue >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {expectedValue >= 0 ? '+' : ''}${expectedValue.toFixed(2)}
                {expectedReturnPct != null && ` (${expectedReturnPct >= 0 ? '+' : ''}${expectedReturnPct.toFixed(1)}%)`}
              </span>
            </>
          )}
        </div>
      </div>

      {!hasData ? (
        <div className="px-4 py-6 text-center text-gray-500 text-sm">
          {eventSlug ? 'No positions for this event' : 'Waiting for event…'}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 divide-x divide-gray-800">
            <div className="px-4 py-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-green-400 font-bold text-sm">UP</span>
                <span className="font-mono text-white text-sm font-bold">
                  {upPos ? upPos.size.toFixed(2) : '0.00'} <span className="text-xs text-gray-500">sh</span>
                </span>
              </div>
              {upPos && (
                <div className="space-y-1 text-xs text-gray-400">
                  <div className="flex justify-between">
                    <span>Avg {(upPos.avgPrice * 100).toFixed(1)}¢</span>
                    <span>Cost ${upPos.initialValue.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Value</span>
                    <span className="text-white font-mono">${(upPos.currentValue ?? upPos.initialValue).toFixed(2)}</span>
                  </div>
                  {(upPos.cashPnl != null || upPos.percentPnl != null) && (
                    <div className={`font-mono font-semibold ${(upPos.cashPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {(upPos.cashPnl ?? 0) >= 0 ? '+' : ''}${(upPos.cashPnl ?? 0).toFixed(2)}
                      {upPos.percentPnl != null && ` (${(upPos.percentPnl >= 0 ? '+' : '')}${upPos.percentPnl.toFixed(1)}%)`}
                    </div>
                  )}
                  {onSell && upPos.size >= 5 && upPrice > 0 && (
                    <div className="flex gap-1 mt-1">
                      <button
                        onClick={() => onSell('up', Math.ceil(upPos.size * 0.25 * 100) / 100, Math.round(upPrice * 100) / 100)}
                        disabled={selling === 'sell-up'}
                        className="flex-1 px-2 py-1 rounded text-[10px] font-bold bg-green-900/30 hover:bg-green-800 text-green-400 border border-green-700/50 transition-colors disabled:opacity-40"
                      >
                        {selling === 'sell-up' ? '...' : `25%`}
                      </button>
                      <button
                        onClick={() => onSell('up', upPos.size, Math.round(upPrice * 100) / 100)}
                        disabled={selling === 'sell-up'}
                        className="flex-1 px-2 py-1 rounded text-[10px] font-bold bg-green-900/50 hover:bg-green-800 text-green-300 border border-green-700/50 transition-colors disabled:opacity-40"
                      >
                        {selling === 'sell-up' ? '...' : `Sell All`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="px-4 py-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-red-400 font-bold text-sm">DOWN</span>
                <span className="font-mono text-white text-sm font-bold">
                  {downPos ? downPos.size.toFixed(2) : '0.00'} <span className="text-xs text-gray-500">sh</span>
                </span>
              </div>
              {downPos && (
                <div className="space-y-1 text-xs text-gray-400">
                  <div className="flex justify-between">
                    <span>Avg {(downPos.avgPrice * 100).toFixed(1)}¢</span>
                    <span>Cost ${downPos.initialValue.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Value</span>
                    <span className="text-white font-mono">${(downPos.currentValue ?? downPos.initialValue).toFixed(2)}</span>
                  </div>
                  {(downPos.cashPnl != null || downPos.percentPnl != null) && (
                    <div className={`font-mono font-semibold ${(downPos.cashPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {(downPos.cashPnl ?? 0) >= 0 ? '+' : ''}${(downPos.cashPnl ?? 0).toFixed(2)}
                      {downPos.percentPnl != null && ` (${(downPos.percentPnl >= 0 ? '+' : '')}${downPos.percentPnl.toFixed(1)}%)`}
                    </div>
                  )}
                  {onSell && downPos.size >= 5 && downPrice > 0 && (
                    <div className="flex gap-1 mt-1">
                      <button
                        onClick={() => onSell('down', Math.ceil(downPos.size * 0.25 * 100) / 100, Math.round(downPrice * 100) / 100)}
                        disabled={selling === 'sell-down'}
                        className="flex-1 px-2 py-1 rounded text-[10px] font-bold bg-red-900/30 hover:bg-red-800 text-red-400 border border-red-700/50 transition-colors disabled:opacity-40"
                      >
                        {selling === 'sell-down' ? '...' : `25%`}
                      </button>
                      <button
                        onClick={() => onSell('down', downPos.size, Math.round(downPrice * 100) / 100)}
                        disabled={selling === 'sell-down'}
                        className="flex-1 px-2 py-1 rounded text-[10px] font-bold bg-red-900/50 hover:bg-red-800 text-red-300 border border-red-700/50 transition-colors disabled:opacity-40"
                      >
                        {selling === 'sell-down' ? '...' : `Sell All`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {onMerge && upPos && downPos && upPos.size > 0 && downPos.size > 0 && (() => {
            const mergeable = Math.min(upPos.size, downPos.size);
            const merge25 = Math.ceil(mergeable * 0.25 * 100) / 100;
            return (
              <div className="px-4 py-2 border-t border-gray-800 flex items-center gap-2">
                <button
                  onClick={() => onMerge(merge25)}
                  disabled={selling === 'merge'}
                  className="px-3 py-1 rounded text-[10px] font-bold bg-blue-900/50 hover:bg-blue-800 text-blue-300 border border-blue-700/50 transition-colors disabled:opacity-40"
                >
                  {selling === 'merge' ? 'Merging...' : `Merge 25% (${merge25.toFixed(1)} sh)`}
                </button>
                <span className="text-[10px] text-gray-500">On-chain CTF merge → ${merge25.toFixed(2)} USDC</span>
              </div>
            );
          })()}

          {(hedgeDownAmount != null || hedgeUpAmount != null || needUpForProfit != null || needDownForProfit != null) && (
            <div className="px-4 py-2 border-t border-gray-800 bg-green-950/20 space-y-1.5">
              {(needDownForProfit != null || needUpForProfit != null) && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">To be profitable either way</p>
                  <div className="text-xs font-mono text-green-400 space-y-0.5">
                    {needDownForProfit != null && (
                      <p>
                        Buy {needDownShares?.toFixed(1)} sh of DOWN at {((maxPriceDownForLock ?? 0.99) * 100).toFixed(1)}¢ or below · ${needDownForProfit.toFixed(2)}
                      </p>
                    )}
                    {needUpForProfit != null && (
                      <p>
                        Buy {needUpShares?.toFixed(1)} sh of UP at {((maxPriceUpForLock ?? 0.99) * 100).toFixed(1)}¢ or below · ${needUpForProfit.toFixed(2)}
                      </p>
                    )}
                  </div>
                </div>
              )}
              {(hedgeDownAmount != null || hedgeUpAmount != null) && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">To hedge (lock payouts)</p>
                  <p className="text-xs font-mono text-green-400/90">
                    {hedgeDownAmount != null && `Buy $${hedgeDownAmount.toFixed(2)} of DOWN`}
                    {hedgeDownAmount != null && hedgeUpAmount != null && ' · '}
                    {hedgeUpAmount != null && `Buy $${hedgeUpAmount.toFixed(2)} of UP`}
                  </p>
                </div>
              )}
            </div>
          )}
          <div className="border-t border-gray-800 grid grid-cols-2 divide-x divide-gray-800">
            <div className="px-4 py-2.5 text-center">
              <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">If UP wins</p>
              <p className={`font-mono font-bold text-sm ${(upPos?.size ?? 0) >= totalCost ? 'text-green-400' : 'text-red-400'}`}>
                {upPos ? `${((upPos.size || 0) - totalCost) >= 0 ? '+' : ''}$${((upPos.size || 0) - totalCost).toFixed(2)}` : '—'}
              </p>
              <p className="text-[10px] text-gray-600 font-mono">Payout ${upPos ? upPos.size.toFixed(2) : '0.00'}</p>
            </div>
            <div className="px-4 py-2.5 text-center">
              <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">If DOWN wins</p>
              <p className={`font-mono font-bold text-sm ${(downPos?.size ?? 0) >= totalCost ? 'text-green-400' : 'text-red-400'}`}>
                {downPos ? `${((downPos.size || 0) - totalCost) >= 0 ? '+' : ''}$${((downPos.size || 0) - totalCost).toFixed(2)}` : '—'}
              </p>
              <p className="text-[10px] text-gray-600 font-mono">Payout ${downPos ? downPos.size.toFixed(2) : '0.00'}</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
