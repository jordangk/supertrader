import React from 'react';

export default function WalletBar({ wallet, liquidityRewards }) {
  const balance = wallet?.portfolioValue ?? wallet?.balance ?? null;
  const rewardsTotal = liquidityRewards?.total ?? 0;
  const hasRewards = rewardsTotal > 0;
  return (
    <div className="text-right flex items-center gap-4">
      <div className="text-right">
        <p className="text-xs text-gray-500">
          Liquidity <a href="https://docs.polymarket.com/market-makers/liquidity-rewards" target="_blank" rel="noopener noreferrer" className="text-cyan-400/80 hover:underline" title="Polymarket maker rewards">↗</a>
        </p>
        <p className={`text-sm font-bold font-mono ${hasRewards ? 'text-cyan-400' : 'text-gray-500'}`}>
          ${rewardsTotal.toFixed(2)}
        </p>
      </div>
      <div className="text-right">
        <p className="text-xs text-gray-500">Wallet</p>
        <p className="text-sm font-bold font-mono text-white">
          {balance !== null ? `$${parseFloat(balance).toFixed(2)}` : '—'}
        </p>
      </div>
    </div>
  );
}
