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

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function App() {
  const { prices, btc, event } = useWebSocket();
  const [wallet, setWallet] = useState(null);
  const [orders, setOrders] = useState([]);
  const [positions, setPositions] = useState([]);
  const [buying, setBuying] = useState(null);
  const [toast, setToast] = useState(null);

  // Fetch wallet + orders on load (positions are fetched when event loads)
  useEffect(() => {
    fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    fetchOrders();
  }, []);

  useEffect(() => {
    if (event?.slug) {
      setPositions([]);
      fetchOrders();
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
      const q = `?event=${encodeURIComponent(event.slug)}`;
      fetch(`${API_BASE}/api/positions${q}`)
        .then(r => r.json())
        .then(d => setPositions(d.positions || []))
        .catch(() => setPositions([]));
    }
  }, [event?.slug]);

  function fetchOrders() {
    fetch(`${API_BASE}/api/orders`)
      .then(r => r.json())
      .then(d => {
        const fromApi = d.orders || [];
        setOrders(prev => {
          const pending = prev.filter(o => String(o.id).startsWith('temp-'));
          const apiIds = new Set(fromApi.map(o => o.polymarket_order_id).filter(Boolean));
          const stillPending = pending.filter(t => !apiIds.has(t.polymarket_order_id));
          return [...stillPending, ...fromApi];
        });
      })
      .catch(() => {});
  }

  async function handleBuy(side, amount) {
    setBuying(`${side}-${amount}`);
    try {
      const res = await fetch(`${API_BASE}/api/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, amount }),
      });
      const data = await res.json();
      setToast({ ...data, side });
      if (data.success && data.trade) {
        const newOrder = {
          ...data.trade,
          id: data.trade.id || `temp-${Date.now()}`,
          order_status: 'filled',
          polymarket_event_id: data.trade.polymarket_event_id || event?.slug,
          polymarket_order_id: data.order?.orderID || data.order?.orderId || data.trade.polymarket_order_id,
          purchase_amount: data.trade.purchase_amount ?? data.purchase_amount ?? (data.shares * data.price),
          shares: data.trade.shares ?? data.shares,
          direction: data.trade.direction ?? side,
        };
        setOrders(prev => [newOrder, ...prev]);
      }
      setTimeout(() => {
        fetchOrders();
        if (event?.slug) {
          fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`)
            .then(r => r.json())
            .then(d => setPositions(d.positions || []))
            .catch(() => {});
        }
      }, 600);
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      const msg = e.message === 'Failed to fetch'
        ? 'Cannot reach server. Is it running on port 3001?'
        : e.message;
      setToast({ success: false, error: msg, side });
    } finally {
      setBuying(null);
    }
  }

  // Orders for current event; fall back to most recent event if filter yields nothing
  let eventOrders = orders;
  if (event?.slug) {
    const filtered = orders.filter(o => (o.polymarket_event_id || o.polymarket_event) === event.slug);
    if (filtered.length > 0) {
      eventOrders = filtered;
    } else if (orders.length > 0) {
      // No match: use most recent event from orders
      const byEvent = {};
      for (const o of orders) {
        const eid = o.polymarket_event_id || o.polymarket_event || '';
        if (!byEvent[eid]) byEvent[eid] = [];
        byEvent[eid].push(o);
      }
      const mostRecent = Object.entries(byEvent).sort((a, b) => {
        const aMax = a[1].length ? Math.max(...a[1].map(x => new Date(x.created_at || x.purchase_time || 0).getTime())) : 0;
        const bMax = b[1].length ? Math.max(...b[1].map(x => new Date(x.created_at || x.purchase_time || 0).getTime())) : 0;
        return bMax - aMax;
      })[0];
      if (mostRecent) eventOrders = mostRecent[1];
    }
  }
  const holdings = { up: { shares: 0, cost: 0 }, down: { shares: 0, cost: 0 } };
  for (const o of eventOrders) {
    if (o.order_status === 'resolved') continue;
    const s = o.direction;
    if (holdings[s]) {
      holdings[s].shares += parseFloat(o.shares || 0);
      holdings[s].cost += parseFloat(o.purchase_amount || 0);
    }
  }
  const totalCost = holdings.up.cost + holdings.down.cost;
  const ev = (prices.upPrice ?? 0) * holdings.up.shares + (prices.downPrice ?? 0) * holdings.down.shares - totalCost;
  const expectedROI = totalCost > 0 ? ev / totalCost : 0;

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

        {/* Threshold to increase expected ROI */}
        {prices?.upPrice != null && prices?.downPrice != null && totalCost > 0 && (
          <div className="rounded-lg border border-green-800/50 bg-green-950/20 px-4 py-2 flex items-center justify-between text-xs">
            <span className="text-gray-400">Buy below to increase expected ROI:</span>
            <span className="font-mono">
              <span className="text-green-400">UP {(prices.upPrice / (1 + expectedROI) * 100).toFixed(1)}¢</span>
              <span className="text-gray-600 mx-2">|</span>
              <span className="text-red-400">DN {(prices.downPrice / (1 + expectedROI) * 100).toFixed(1)}¢</span>
            </span>
          </div>
        )}

        {/* Buy Panels */}
        <div className="grid grid-cols-2 gap-3">
          <BuyPanel
            side="up"
            price={prices.upPrice}
            amounts={AMOUNTS}
            buying={buying}
            onBuy={handleBuy}
            holdings={holdings}
            expectedROI={expectedROI}
          />
          <BuyPanel
            side="down"
            price={prices.downPrice}
            amounts={AMOUNTS}
            buying={buying}
            onBuy={handleBuy}
            holdings={holdings}
            expectedROI={expectedROI}
          />
        </div>

        {/* Positions — Polymarket API when available, else derive from orders */}
        <Positions
          positions={positions}
          eventSlug={event?.slug}
          fallbackOrders={eventOrders}
          prices={prices}
        />

        {/* Orders */}
        <OrderHistory orders={eventOrders} prices={prices} />

        {/* Toast */}
        <OrderToast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </div>
  );
}
