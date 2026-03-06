import React, { useEffect, useState } from 'react';

export default function OrderToast({ toast, onDismiss }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const isBuyBothError = toast.type === 'buy-both' && !toast.success && (toast.up?.error || toast.down?.error);
    const duration = isBuyBothError ? 7000 : 3000;
    const t = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 200);
    }, duration);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;

  const isSuccess = toast.success;

  return (
    <div
      className={`
        fixed top-4 right-4 z-40 w-64
        transition-opacity duration-300 pointer-events-none
        ${visible ? 'opacity-100' : 'opacity-0'}
      `}
      aria-live="polite"
    >
      <div className={`
        px-3 py-2 rounded-xl shadow-xl border text-xs
        ${isSuccess
          ? 'bg-green-900/95 border-green-600 text-green-200'
          : 'bg-red-900/95 border-red-600 text-red-200'
        }
      `}>
        <div className="flex items-center gap-2 flex-wrap">
          <span>{isSuccess ? (toast.type === 'buy-then-sell' ? '🔄' : toast.type === 'buy-both' ? '⚡' : toast.isSell ? '💰' : toast.isLimit ? '📋' : '✅') : '❌'}</span>
          <span className="font-semibold">
            {toast.type === 'buy-both'
              ? (toast.success ? (toast.message || 'Both placed') : (toast.message || toast.error || 'Failed'))
              : isSuccess ? (toast.type === 'buy-then-sell' ? (toast.message || 'Buys placed. Sells when filled.') : toast.isBuyBoth ? `Both: ${toast.filled || 0} filled, ${toast.live || 0} limits` : toast.isSell ? 'Sell listed' : toast.isLimit ? 'Limit set' : 'Filled') : (toast.isBuyBoth || toast.type === 'buy-then-sell' ? 'Both failed' : 'Failed')}
          </span>
          {!toast.isBuyBoth && toast.type !== 'buy-then-sell' && <span className="font-mono font-bold">{toast.side?.toUpperCase()}</span>}
          {isSuccess && toast.type !== 'buy-then-sell' && toast.type !== 'buy-both' && (
            <span className="font-mono">
              ${parseFloat(toast.purchase_amount ?? toast.shares * toast.price ?? 0).toFixed(2)}
              {toast.price ? ` @ ${(parseFloat(toast.price) * 100).toFixed(1)}¢` : ''}
              {' · '}{parseFloat(toast.shares || 0).toFixed(1)} sh
            </span>
          )}
          {!isSuccess && toast.error && <span className="opacity-90">{toast.error}</span>}
          {toast.type === 'buy-both' && toast.up && toast.down && (
            <span className="opacity-90 block mt-0.5">
              UP {toast.up.ok ? '✓' : '✗'} · DOWN {toast.down.ok ? '✓' : '✗'}
              {toast.up.error && <span className="block text-red-300 text-[10px]">UP: {toast.up.error}</span>}
              {toast.down.error && <span className="block text-red-300 text-[10px]">DOWN: {toast.down.error}</span>}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
