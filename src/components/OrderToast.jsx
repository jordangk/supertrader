import React, { useEffect, useState } from 'react';

export default function OrderToast({ toast, onDismiss }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 400);
    }, 3000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;

  const isSuccess = toast.success;

  return (
    <div className={`
      fixed bottom-6 left-1/2 -translate-x-1/2 z-50
      transition-all duration-300
      ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}
    `}>
      <div className={`
        flex items-center gap-3 px-5 py-3 rounded-2xl shadow-2xl border text-sm font-semibold
        ${isSuccess
          ? 'bg-green-900 border-green-600 text-green-200'
          : 'bg-red-900 border-red-600 text-red-200'
        }
      `}>
        <span className="text-xl">{isSuccess ? '✅' : '❌'}</span>
        <div>
          {isSuccess ? (
            <>
              <div>Order Filled</div>
              <div className="text-xs font-normal opacity-80">
                {toast.side?.toUpperCase()} · {parseFloat(toast.shares).toFixed(2)} shares @ {(toast.price * 100).toFixed(1)}¢
              </div>
            </>
          ) : (
            <>
              <div>Order Failed</div>
              <div className="text-xs font-normal opacity-80">{toast.error || 'Try again'}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
