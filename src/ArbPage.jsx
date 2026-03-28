import React from 'react';
import ArbitrageLab from './components/ArbitrageLab.jsx';

/** Standalone page — not mounted inside the heavy main App (avoids shared crash surface). */
export default function ArbPage() {
  return (
    <div className="min-h-screen bg-gray-950 flex flex-col text-gray-100">
      <header className="bg-gray-900 border-b border-amber-900/40 px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xl font-bold text-amber-400">Arb Lab</span>
          <span className="text-[10px] text-gray-500 hidden sm:inline font-mono">
            npm run dev → localhost:5173/arb
          </span>
        </div>
        <a
          href="/"
          className="text-sm text-blue-400 hover:text-blue-300 hover:underline"
        >
          ← Main dashboard
        </a>
      </header>
      <div className="flex-1 p-4 max-w-5xl mx-auto w-full overflow-auto">
        <ArbitrageLab />
      </div>
    </div>
  );
}
