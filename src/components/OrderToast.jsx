import React, { useEffect, useState } from 'react';

function fmtTime(secs) {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function OrderToast({ toast, onDismiss }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 400);
    }, 5000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;

  const isSuccess = toast.success;
  const snap = toast.snapshot;

  return (
    <div className={`
      fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-80
      transition-all duration-300
      ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}
    `}>
      <div className={`
        px-4 py-3 rounded-2xl shadow-2xl border text-sm
        ${isSuccess
          ? 'bg-green-900 border-green-600 text-green-200'
          : 'bg-red-900 border-red-600 text-red-200'
        }
      `}>
        <div className="flex items-center gap-2 font-semibold mb-2">
          <span className="text-lg">{isSuccess ? '✅' : '❌'}</span>
          <span>{isSuccess ? 'Order Filled' : 'Order Failed'}</span>
        </div>

        {isSuccess ? (
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-green-300/70">Side</span>
              <span className="font-mono font-bold">{toast.side?.toUpperCase()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-green-300/70">Shares</span>
              <span className="font-mono">{parseFloat(toast.shares).toFixed(2)} @ {(toast.price * 100).toFixed(1)}¢</span>
            </div>
            {snap && (
              <>
                <div className="border-t border-green-700/50 my-1" />
                <div className="flex justify-between">
                  <span className="text-green-300/70">Up / Down</span>
                  <span className="font-mono">
                    <span className="text-green-400">{snap.upPrice ? `${(snap.upPrice * 100).toFixed(1)}¢` : '—'}</span>
                    {' / '}
                    <span className="text-red-400">{snap.downPrice ? `${(snap.downPrice * 100).toFixed(1)}¢` : '—'}</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-green-300/70">Time left</span>
                  <span className="font-mono">{fmtTime(snap.timeLeftSecs)}</span>
                </div>
                {snap.holdings && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-green-300/70">Up holdings</span>
                      <span className="font-mono">
                        {snap.holdings.up.shares.toFixed(2)} sh · ${snap.holdings.up.cost.toFixed(2)}
                        {snap.holdings.up.value != null && ` → $${snap.holdings.up.value.toFixed(2)}`}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-green-300/70">Down holdings</span>
                      <span className="font-mono">
                        {snap.holdings.down.shares.toFixed(2)} sh · ${snap.holdings.down.cost.toFixed(2)}
                        {snap.holdings.down.value != null && ` → $${snap.holdings.down.value.toFixed(2)}`}
                      </span>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="text-xs opacity-80">{toast.error || 'Try again'}</div>
        )}
      </div>
    </div>
  );
}
