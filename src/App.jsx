import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket.js';
import EventHeader from './components/EventHeader.jsx';
import BTCBar from './components/BTCBar.jsx';
import PricePanel from './components/PricePanel.jsx';
import BuyPanel from './components/BuyPanel.jsx';
import WalletBar from './components/WalletBar.jsx';
import OrderHistory from './components/OrderHistory.jsx';
import Positions from './components/Positions.jsx';
import LimitOrderPanel from './components/LimitOrderPanel.jsx';
import OrderToast from './components/OrderToast.jsx';

const AMOUNTS = [50, 20, 10, 5, 1];
const FEE_PCT = 0.02; // 2% Polymarket fee

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function App() {
  const { prices, btc, event, autoSell } = useWebSocket();
  const [wallet, setWallet] = useState(null);
  const [orders, setOrders] = useState([]);
  const [positions, setPositions] = useState([]);
  const [buying, setBuying] = useState(null);
  const [toast, setToast] = useState(null);
  const [openOrders, setOpenOrders] = useState([]);
  const [postAction, setPostAction] = useState(() => localStorage.getItem('postAction') || 'none');
  // Persist postAction so it survives Vite hot-reload
  function updatePostAction(val) { localStorage.setItem('postAction', val); setPostAction(val); }
  // Track live orders that need a force sell when they fill
  const pendingSells = useRef({}); // { orderId: { side, tokenId, shares, price } }
  // Keep current event in a ref so polling closures always see the latest value
  const eventRef = useRef(null);
  eventRef.current = event;
  // Track sell orders with stop-losses: { sellOrderId: { side, tokenId, shares, buyPrice, stopPrice } }
  const stopLosses = useRef({});
  const pricesRef = useRef(prices);
  pricesRef.current = prices;

  function fetchOpenOrders() {
    fetch(`${API_BASE}/api/open-orders`).then(r => r.json()).then(d => {
      const openList = d.orders || [];
      setOpenOrders(openList);
      // Check if any pending sell orders have been filled (no longer in open list)
      const openIds = new Set(openList.map(o => o.id));
      const pending = pendingSells.current;
      for (const orderId of Object.keys(pending)) {
        if (!openIds.has(orderId)) {
          // Order filled! Trigger the force sell
          const { side, tokenId, shares, price, action } = pending[orderId];
          delete pending[orderId];
          if (action === 'forcesell') {
            const sellPrice = Math.round((price + 0.01) * 100) / 100;
            if (sellPrice > 0 && sellPrice < 1) {
              console.log('[ForceSell] Live order filled, selling', shares, 'sh at', sellPrice);
              setTimeout(() => {
                fetch(`${API_BASE}/api/sell`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ side, shares, price: sellPrice, tokenId }),
                }).then(r => r.json()).then(sellRes => {
                  if (sellRes.success) {
                    const sellOrderId = sellRes.order?.orderID || sellRes.order?.orderId;
                    setToast({ success: true, isLimit: true, side, isSell: true, price: sellPrice, shares });
                    // Track for stop-loss at buyPrice - 10¢
                    if (sellOrderId) {
                      stopLosses.current[sellOrderId] = { side, tokenId, shares, buyPrice: price, stopPrice: Math.round((price - 0.10) * 100) / 100 };
                      console.log('[StopLoss] Tracking sell', sellOrderId, 'stop at', (price - 0.10).toFixed(2));
                    }
                    fetchOpenOrders();
                  } else {
                    setToast({ success: false, error: `Sell failed: ${sellRes.error}`, side });
                  }
                }).catch(() => {});
              }, 5000); // Wait 5s for on-chain settlement
            }
          } else if (action === 'trigger') {
            const oppSide = side === 'up' ? 'down' : 'up';
            const oppLimit = Math.round((1 - price - 0.01) * 100) / 100;
            if (oppLimit > 0 && oppLimit < 1) {
              console.log('[Trigger] Live order filled, placing opposite limit', oppSide, oppLimit);
              fetch(`${API_BASE}/api/buy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ side: oppSide, amount: shares * price, limitPrice: oppLimit }),
              }).then(r => r.json()).then(d => {
                console.log('[Trigger]', oppSide, oppLimit, d.success ? 'placed' : d.error);
              }).catch(() => {});
            }
          }
        }
      }

      // Check stop-losses: if price dropped 10¢ below buy, cancel sell and market sell
      const sl = stopLosses.current;
      for (const sellOrderId of Object.keys(sl)) {
        if (!openIds.has(sellOrderId)) {
          // Sell order already filled or cancelled, remove tracking
          delete sl[sellOrderId];
          continue;
        }
        const { side, tokenId, shares, stopPrice } = sl[sellOrderId];
        const curPrice = side === 'up' ? pricesRef.current.upPrice : pricesRef.current.downPrice;
        if (curPrice != null && curPrice <= stopPrice) {
          console.log('[StopLoss] Triggered!', side, 'price', curPrice, '<= stop', stopPrice);
          delete sl[sellOrderId];
          // Cancel the existing sell order, then market sell
          fetch(`${API_BASE}/api/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: sellOrderId }),
          }).then(r => r.json()).then(() => {
            // Market sell: use current price - 1¢ to ensure fill
            const marketSellPrice = Math.max(0.01, Math.round((curPrice - 0.01) * 100) / 100);
            fetch(`${API_BASE}/api/sell`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ side, shares, price: marketSellPrice, tokenId }),
            }).then(r => r.json()).then(d => {
              if (d.success) {
                setToast({ success: true, isLimit: true, side, isSell: true, price: marketSellPrice, shares });
              } else {
                setToast({ success: false, error: `Stop-loss sell failed: ${d.error}`, side });
              }
              fetchOpenOrders();
            }).catch(() => {});
          }).catch(() => {});
        }
      }
    }).catch(() => {});
  }

  function fetchPositions() {
    const ev = eventRef.current;
    if (!ev?.slug) return;
    const q = `?event=${encodeURIComponent(ev.slug)}`;
    fetch(`${API_BASE}/api/positions${q}`)
      .then(r => r.json())
      .then(d => setPositions(d.positions || []))
      .catch(() => {});
  }

  // Show toast + refresh orders when server auto-sells
  useEffect(() => {
    if (autoSell) {
      setToast({ success: true, isSell: true, side: autoSell.side, price: autoSell.price, shares: autoSell.shares, purchase_amount: autoSell.shares * autoSell.price });
      fetchOrders();
      fetchOpenOrders();
    }
  }, [autoSell]);

  // Fetch wallet + orders on load (positions are fetched when event loads)
  useEffect(() => {
    fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    fetchOrders();
    fetchOpenOrders();
    const iv = setInterval(() => { fetchOpenOrders(); fetchOrders(); fetchPositions(); }, 3000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (event?.slug) {
      setPositions([]);
      fetchOrders();
      fetchPositions();
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
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

  async function handleBuy(side, amount, limitPrice) {
    const buyKey = limitPrice ? `limit-${side}` : `${side}-${amount}`;
    setBuying(buyKey);
    try {
      const body = { side, amount, postAction };
      if (limitPrice) body.limitPrice = limitPrice;
      const res = await fetch(`${API_BASE}/api/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const isMatched = data.order?.status === 'matched';
      const isLive = data.order?.status === 'live';
      setToast({ ...data, side, isLimit: data.success && !isMatched });

      // Track live (limit) orders for post-buy actions when they fill later
      if (data.success && isLive && postAction !== 'none') {
        const orderId = data.order?.orderID || data.order?.orderId;
        if (orderId) {
          pendingSells.current[orderId] = {
            side,
            tokenId: data.tokenId,
            shares: data.shares || parseFloat(data.trade?.shares),
            price: data.price || parseFloat(data.trade?.purchase_price),
            action: postAction,
          };
          console.log('[PendingSell] Tracking live order', orderId, 'for', postAction);
        }
      }

      if (data.success && data.trade && isMatched) {
        const newOrder = {
          ...data.trade,
          id: data.trade.id || `temp-${Date.now()}`,
          order_status: 'filled',
          polymarket_event_id: data.trade.polymarket_event_id || event?.dbEventId,
          polymarket_order_id: data.order?.orderID || data.order?.orderId || data.trade.polymarket_order_id,
          purchase_amount: data.trade.purchase_amount ?? data.purchase_amount ?? (data.shares * data.price),
          shares: data.trade.shares ?? data.shares,
          direction: data.trade.direction ?? side,
        };
        setOrders(prev => [newOrder, ...prev]);

        // Trigger + ForceSell are handled server-side now (via postAction in request body)
      }
      setTimeout(() => {
        fetchOrders();
        fetchOpenOrders();
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

  async function handleBuyBoth(amount) {
    setBuying('both');
    try {
      const res = await fetch(`${API_BASE}/api/buy-both`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      const data = await res.json();
      setToast({
        success: data.success,
        isBuyBoth: true,
        filled: data.filled || 0,
        live: data.live || 0,
        error: data.error,
      });
      setTimeout(() => { fetchOrders(); fetchOpenOrders(); }, 600);
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      setToast({ success: false, error: e.message, isBuyBoth: true });
    } finally {
      setBuying(null);
    }
  }

  async function handleSellBoth(amount) {
    setBuying('sellboth');
    try {
      const res = await fetch(`${API_BASE}/api/sell-both`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      const data = await res.json();
      setToast({
        success: data.success,
        isSell: true,
        isBuyBoth: true,
        filled: data.filled || 0,
        live: data.live || 0,
        error: data.error,
      });
      setTimeout(() => { fetchOrders(); fetchOpenOrders(); }, 600);
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      setToast({ success: false, error: e.message, isSell: true });
    } finally {
      setBuying(null);
    }
  }

  async function handleSellPosition(side, shares, price) {
    setBuying(`sell-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares, price }),
      });
      const data = await res.json();
      setToast({ success: data.success, isSell: true, side, error: data.error });
      setTimeout(() => { fetchOrders(); fetchOpenOrders(); fetchPositions(); }, 600);
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      setToast({ success: false, error: e.message, isSell: true });
    } finally {
      setBuying(null);
    }
  }

  async function handleMerge(shares) {
    setBuying('merge');
    try {
      const res = await fetch(`${API_BASE}/api/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shares }),
      });
      const data = await res.json();
      setToast({ success: data.success, isSell: true, error: data.error || data.results?.filter(r => !r.success).map(r => `${r.side}: ${r.error}`).join(', ') });
      setTimeout(() => { fetchOrders(); fetchOpenOrders(); fetchPositions(); }, 600);
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      setToast({ success: false, error: e.message, isSell: true });
    } finally {
      setBuying(null);
    }
  }

  async function handleCancel(orderId) {
    try {
      await fetch(`${API_BASE}/api/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      setOpenOrders(prev => prev.filter(o => o.id !== orderId));
      fetchOpenOrders();
      fetchOrders();
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  // Orders for current event; fall back to most recent event if filter yields nothing
  let eventOrders = orders;
  if (event?.dbEventId) {
    const eid = String(event.dbEventId);
    const filtered = orders.filter(o => String(o.polymarket_event_id) === eid);
    if (filtered.length > 0) {
      eventOrders = filtered;
    } else if (orders.length > 0) {
      // No match: use most recent event from orders
      const byEvent = {};
      for (const o of orders) {
        const eid = String(o.polymarket_event_id || '');
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
  const ordersForCurrentEvent = event?.dbEventId ? orders.filter(o => String(o.polymarket_event_id) === String(event.dbEventId)) : [];
  const hasPositionsThisEvent = ordersForCurrentEvent.some(o => o.order_status !== 'resolved');

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

        {/* Limit Order + Limit Trigger toggle */}
        <LimitOrderPanel prices={prices} buying={buying} onBuy={handleBuy} onBuyBoth={handleBuyBoth} onSellBoth={handleSellBoth} openOrders={openOrders} onCancel={handleCancel} postAction={postAction} onSetPostAction={updatePostAction} />

        {/* Threshold to increase expected ROI */}
        {prices?.upPrice != null && prices?.downPrice != null && totalCost > 0 && hasPositionsThisEvent && (() => {
          const upTh = Math.min(prices.upPrice / (1 + expectedROI), 0.99);
          const dnTh = Math.min(prices.downPrice / (1 + expectedROI), 0.99);
          return (
            <div className="rounded-lg border border-green-800/50 bg-green-950/20 px-4 py-2 flex items-center justify-between text-xs">
              <span className="text-gray-400">Buy below to increase expected ROI:</span>
              <span className="font-mono">
                <span className="text-green-400">UP {(upTh * 100).toFixed(1)}¢</span>
                <span className="text-gray-600 mx-2">|</span>
                <span className="text-red-400">DN {(dnTh * 100).toFixed(1)}¢</span>
              </span>
            </div>
          );
        })()}

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
            showROIHint={hasPositionsThisEvent}
          />
          <BuyPanel
            side="down"
            price={prices.downPrice}
            amounts={AMOUNTS}
            buying={buying}
            onBuy={handleBuy}
            holdings={holdings}
            expectedROI={expectedROI}
            showROIHint={hasPositionsThisEvent}
          />
        </div>

        {/* Positions — Polymarket API when available, else derive from orders */}
        <Positions
          positions={positions}
          eventSlug={event?.slug}
          dbEventId={event?.dbEventId}
          fallbackOrders={eventOrders}
          prices={prices}
          onSell={handleSellPosition}
          onMerge={handleMerge}
          selling={buying}
        />

        {/* Orders */}
        <OrderHistory orders={eventOrders} prices={prices} />

        {/* Toast */}
        <OrderToast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </div>
  );
}
