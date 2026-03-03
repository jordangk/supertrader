import React, { useEffect, useState } from 'react';

export default function OrderToast({ toast, onDismiss }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 200);
    }, 3000);
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
          <span>{isSuccess ? '✅' : '❌'}</span>
          <span className="font-semibold">{isSuccess ? 'Filled' : 'Failed'}</span>
          <span className="font-mono font-bold">{toast.side?.toUpperCase()}</span>
          {isSuccess && (
            <span className="font-mono">${parseFloat(toast.purchase_amount ?? toast.shares * toast.price ?? 0).toFixed(2)} · {parseFloat(toast.shares || 0).toFixed(1)} sh</span>
          )}
          {!isSuccess && toast.error && <span className="opacity-90">{toast.error}</span>}
        </div>
      </div>
    </div>
  );
}
