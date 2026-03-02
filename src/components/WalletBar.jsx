import React from 'react';

export default function WalletBar({ wallet }) {
  const balance = wallet?.portfolioValue ?? wallet?.balance ?? null;
  return (
    <div className="text-right">
      <p className="text-xs text-gray-500">Wallet</p>
      <p className="text-sm font-bold font-mono text-white">
        {balance !== null ? `$${parseFloat(balance).toFixed(2)}` : '—'}
      </p>
    </div>
  );
}
