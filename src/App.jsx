import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket.js';
import EventHeader from './components/EventHeader.jsx';
import BTCBar from './components/BTCBar.jsx';
import PricePanel from './components/PricePanel.jsx';
import BuyPanel from './components/BuyPanel.jsx';
import WalletBar from './components/WalletBar.jsx';
import OrderHistory from './components/OrderHistory.jsx';
import Positions from './components/Positions.jsx';
import OrderToast from './components/OrderToast.jsx';

const AMOUNTS = [50, 20, 10, 5, 1];
const FEE_PCT = 0.02; // 2% Polymarket fee

export default function App() {
  const { prices, btc, event } = useWebSocket();
  const [wallet, setWallet] = useState(null);
  const [orders, setOrders] = useState([]);
  const [buying, setBuying] = useState(null);
  const [toast, setToast] = useState(null);

  // Fetch wallet + orders on load and when event changes
  useEffect(() => {
    fetch('/api/wallet').then(r => r.json()).then(setWallet).catch(() => {});
    fetchOrders();
  }, []);

  // Refetch orders when a new event arrives
  useEffect(() => {
    if (event?.slug) {
      fetchOrders();
      fetch('/api/wallet').then(r => r.json()).then(setWallet).catch(() => {});
    }
  }, [event?.slug]);

  function fetchOrders() {
    fetch('/api/orders').then(r => r.json()).then(d => setOrders(d.orders || [])).catch(() => {});
  }

  async function handleBuy(side, amount) {
    setBuying(`${side}-${amount}`);
    try {
      const res = await fetch('/api/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, amount }),
      });
      const data = await res.json();
      setToast({ ...data, side });
      fetchOrders();
      fetch('/api/wallet').then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally {
      setBuying(null);
    }
  }

  // Compute current holdings from orders
  const holdings = { up: { shares: 0, cost: 0 }, down: { shares: 0, cost: 0 } };
  for (const o of orders) {
    if (o.order_status === 'resolved') continue;
    const s = o.direction;
    if (holdings[s]) {
      holdings[s].shares += parseFloat(o.shares || 0);
      holdings[s].cost += parseFloat(o.purchase_amount || 0);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-orange-500 text-2xl">₿</span>
          <span className="font-bold text-lg tracking-tight">SuperTrader</span>
        </div>
        <WalletBar wallet={wallet} />
      </div>

      <div className="flex-1 p-4 max-w-2xl mx-auto w-full space-y-4">
        {/* Event */}
        <EventHeader event={event} />

        {/* BTC Price Bar */}
        <BTCBar btc={btc} />

        {/* Live Prices */}
        <PricePanel prices={prices} />

        {/* Buy Panels */}
        <div className="grid grid-cols-2 gap-3">
          <BuyPanel
            side="up"
            price={prices.upPrice}
            amounts={AMOUNTS}
            buying={buying}
            onBuy={handleBuy}
            holdings={holdings}
          />
          <BuyPanel
            side="down"
            price={prices.downPrice}
            amounts={AMOUNTS}
            buying={buying}
            onBuy={handleBuy}
            holdings={holdings}
          />
        </div>

        {/* Positions */}
        <Positions orders={orders} prices={prices} />

        {/* Orders */}
        <OrderHistory orders={orders} prices={prices} />

        {/* Toast */}
        <OrderToast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </div>
  );
}
