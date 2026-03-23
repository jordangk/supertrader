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
import K9Trades from './components/K9Trades.jsx';
import MyTrades from './components/MyTrades.jsx';
import LiveBetsConfig from './components/LiveBetsConfig.jsx';
import SimDashboard from './components/SimDashboard.jsx';
import PriceTracker from './components/PriceTracker.jsx';
import EventSearch from './components/EventSearch.jsx';
import PriceDivergence from './components/PriceDivergence.jsx';
import EmaTradeLog from './components/EmaTradeLog.jsx';

const AMOUNTS = [50, 25, 10, 5];
const FEE_PCT = 0.02; // 2% Polymarket fee

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function App() {
  const { prices, btc, binanceBtc, event, refreshTrigger, copyFeed, whaleTrades } = useWebSocket();
  const [wallet, setWallet] = useState(null);
  const [orders, setOrders] = useState([]);
  const [positions, setPositions] = useState([]);
  const [openOrders, setOpenOrders] = useState([]);
  const [buying, setBuying] = useState(null);
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState('divergence');
  const [showEventSearch, setShowEventSearch] = useState(false);
  const [liquidityRewards, setLiquidityRewards] = useState({ total: 0, byDate: [] });
  const [autoScalp, setAutoScalp] = useState({ enabled: false, threshold: 5, profitCents: 2, shares: 50, log: [] });
  const [buySell, setBuySell] = useState({ price: '', shares: 5, profit: 3 });
  const [autoFlow, setAutoFlow] = useState({ enabled: false, log: [], upFlow: null, downFlow: null });
  const [autoEma, setAutoEma] = useState({ enabled: false, phase: null, log: [], ema: {} });
  const [autoLost, setAutoLost] = useState({ enabled: false, side: 'down', shares: 10, buyPrice: 0.02, sellPrice: 0.07, log: [] });

  function fetchOpenOrders() {
    fetch(`${API_BASE}/api/open-orders`)
      .then(r => r.json())
      .then(d => setOpenOrders(d.orders || []))
      .catch(() => {});
  }

  // Fetch wallet + orders + liquidity rewards on load (positions are fetched when event loads)
  function fetchLiquidityRewards() {
    fetch(`${API_BASE}/api/liquidity-rewards?days=7`)
      .then(r => r.json())
      .then(d => setLiquidityRewards(d))
      .catch(() => setLiquidityRewards({ total: 0, byDate: [] }));
  }
  useEffect(() => {
    fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    fetchLiquidityRewards();
    fetchOrders();
    fetchOpenOrders();
    // Poll open orders every 5s
    const iv = setInterval(fetchOpenOrders, 5000);
    // Refresh liquidity rewards every 5 min (rewards distributed daily at midnight UTC)
    const rv = setInterval(fetchLiquidityRewards, 5 * 60 * 1000);
    fetchAutoScalp();
    fetchAutoFlow();
    fetchAutoEma();
    fetchAutoLost();
    const asIv = setInterval(fetchAutoScalp, 5000);
    const afIv = setInterval(fetchAutoFlow, 3000);
    const aeIv = setInterval(fetchAutoEma, 2000);
    const alIv = setInterval(fetchAutoLost, 5000);
    return () => { clearInterval(iv); clearInterval(rv); clearInterval(asIv); clearInterval(afIv); clearInterval(aeIv); clearInterval(alIv); };
  }, []);

  function fetchAutoScalp() {
    fetch(`${API_BASE}/api/auto-scalp`).then(r => r.json()).then(setAutoScalp).catch(() => {});
  }
  function fetchAutoFlow() {
    fetch(`${API_BASE}/api/auto-flow`).then(r => { if (r.ok) return r.json(); throw new Error(); }).then(setAutoFlow).catch(() => {});
  }

  function fetchAutoEma() {
    fetch(`${API_BASE}/api/auto-ema`).then(r => { if (r.ok) return r.json(); throw new Error(); }).then(setAutoEma).catch(() => {});
  }
  async function toggleAutoEma() {
    try {
      const cur = await fetch(`${API_BASE}/api/auto-ema`).then(r => r.json());
      const res = await fetch(`${API_BASE}/api/auto-ema`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !cur.enabled }),
      });
      const data = await res.json();
      setAutoEma(prev => ({ ...prev, ...data }));
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  function fetchAutoLost() {
    fetch(`${API_BASE}/api/auto-lost`).then(r => { if (r.ok) return r.json(); throw new Error(); }).then(setAutoLost).catch(() => {});
  }
  async function toggleAutoLost() {
    try {
      const cur = await fetch(`${API_BASE}/api/auto-lost`).then(r => r.json());
      const res = await fetch(`${API_BASE}/api/auto-lost`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !cur.enabled }),
      });
      const data = await res.json();
      setAutoLost(prev => ({ ...prev, ...data }));
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }
  async function setAutoLostSide(side) {
    try {
      const res = await fetch(`${API_BASE}/api/auto-lost`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      setAutoLost(prev => ({ ...prev, ...data }));
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  async function toggleAutoFlow() {
    try {
      const cur = await fetch(`${API_BASE}/api/auto-flow`).then(r => r.json());
      const res = await fetch(`${API_BASE}/api/auto-flow`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !cur.enabled }),
      });
      const data = await res.json();
      setAutoFlow(prev => ({ ...prev, ...data }));
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  async function toggleAutoScalp() {
    try {
      // Read current state from server first to avoid stale closure
      const cur = await fetch(`${API_BASE}/api/auto-scalp`).then(r => r.json());
      const res = await fetch(`${API_BASE}/api/auto-scalp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !cur.enabled }),
      });
      const data = await res.json();
      setAutoScalp(prev => ({ ...prev, ...data, ref: data.lastTriggerPrice ?? prev.ref, btc: prev.btc }));
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  useEffect(() => {
    if (event?.slug) {
      setPositions([]);
      fetchOrders();
      fetchOpenOrders();
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
      const q = `?event=${encodeURIComponent(event.slug)}`;
      fetch(`${API_BASE}/api/positions${q}`)
        .then(r => r.json())
        .then(d => setPositions(d.positions || []))
        .catch(() => setPositions([]));
    }
  }, [event?.slug]);

  // When server broadcasts 'refresh' (e.g. buy-then-sell placed sells), refresh orders + positions
  useEffect(() => {
    if (refreshTrigger > 0) {
      fetchOrders();
      fetchOpenOrders();
      if (event?.slug) {
        fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`)
          .then(r => r.json())
          .then(d => setPositions(d.positions || []))
          .catch(() => {});
      }
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    }
  }, [refreshTrigger]);

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
        body: JSON.stringify({ side, shares: amount }),
      });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (parseErr) {
        setToast({ success: false, error: `Server error (not JSON). Is server running? ${res.status}`, side });
        return;
      }
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

  async function handleRewardsBuy(side) {
    setBuying(`rewards-buy-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/rewards-buy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      setToast({ ...data, side, type: 'rewards-buy' });
      setTimeout(() => { fetchOrders(); fetchOpenOrders(); }, 600);
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleRewardsSell(side) {
    setBuying(`rewards-sell-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/rewards-sell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      setToast({ ...data, side, type: 'rewards-sell' });
      setTimeout(() => { fetchOrders(); fetchOpenOrders(); }, 600);
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleSuperRewards(side) {
    setBuying(`super-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/super-rewards`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      setToast({ ...data, side, type: 'super-rewards' });
      fetchOrders(); fetchOpenOrders();
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleWhaleStyleBuy(side, discountCents = 2) {
    setBuying(`whale-style-${side}-${discountCents}`);
    try {
      const res = await fetch(`${API_BASE}/api/whale-style-buy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares: 5, discountCents }),
      });
      const data = await res.json();
      if (!res.ok) setToast({ success: false, error: data.error || `HTTP ${res.status}`, side });
      else setToast({ ...data, side, type: 'whale-style', discountCents });
      if (data.success) {
        fetchOrders(); fetchOpenOrders();
        fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
      }
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleSuperSell(side) {
    setBuying(`super-sell-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/super-sell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      setToast({ ...data, side, type: 'super-sell' });
      fetchOrders(); fetchOpenOrders();
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleSell(side, shares, price) {
    setBuying(`sell-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares }),
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch {
        setToast({ success: false, error: `Invalid response (${res.status})`, side, type: 'sell' });
        return;
      }
      setToast({ ...data, side, type: 'sell', isSell: data.success });
      const refresh = () => {
        fetchOrders();
        fetchOpenOrders();
        if (event?.slug) {
          fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`)
            .then(r => r.json())
            .then(d => setPositions(d.positions || []))
            .catch(() => {});
        }
        fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
      };
      refresh();
      setTimeout(refresh, 800);
      setTimeout(refresh, 2000);
      setTimeout(refresh, 5000);
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally {
      setBuying(null);
    }
  }

  async function handleSellAll(side, tokenId) {
    setBuying(`sellall-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/sell-all`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, ...(tokenId && { tokenId }) }),
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch {
        setToast({ success: false, error: `Invalid response (${res.status})`, side, type: 'sell-all' });
        return;
      }
      setToast({ ...data, side, type: 'sell-all', isSell: data.success });
      const refresh = () => {
        fetchOrders();
        fetchOpenOrders();
        if (event?.slug) {
          fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`)
            .then(r => r.json()).then(d => setPositions(d.positions || [])).catch(() => {});
        }
        fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
      };
      refresh();
      setTimeout(refresh, 800);
      setTimeout(refresh, 2000);
      setTimeout(refresh, 5000);
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleBuySell(side) {
    const p = parseFloat(buySell.price) / 100;
    if (!p || p <= 0 || p >= 1) { setToast({ success: false, error: 'Enter price in cents (1-99)' }); return; }
    setBuying('bs-' + side);
    try {
      const res = await fetch(`${API_BASE}/api/buy-sell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, price: p, shares: buySell.shares, profitCents: buySell.profit }),
      });
      const data = await res.json();
      if (data.success) setToast({ success: true, message: `${side.toUpperCase()}: buy@${buySell.price}¢ sell@${(parseFloat(buySell.price)+buySell.profit).toFixed(0)}¢` });
      else setToast({ success: false, error: data.error });
    } catch (e) { setToast({ success: false, error: e.message }); }
    setBuying(null);
  }

  async function handleLostScalp(side) {
    setBuying('lost-' + side);
    try {
      const res = await fetch(`${API_BASE}/api/lost-scalp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      if (data.success) setToast({ success: true, message: `Lost ${side.toUpperCase()}: buy@2¢ sell@7¢` });
      else setToast({ success: false, error: data.error });
    } catch (e) { setToast({ success: false, error: e.message }); }
    setBuying(null);
  }

  async function handleBuyBoth() {
    setBuying('buy-both');
    try {
      const res = await fetch(`${API_BASE}/api/buy-both`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        setToast({ success: false, error: `Invalid response (${res.status})`, type: 'buy-both' });
        return;
      }
      setToast({ ...data, type: 'buy-both', message: data.message, up: data.up, down: data.down });
      if (data.success) {
        const nowIso = new Date().toISOString();
        const optimistic = [];
        if (data.up?.orderID) optimistic.push({ id: `temp-${Date.now()}-up`, polymarket_order_id: data.up.orderID, polymarket_event_id: event?.slug, direction: 'up', purchase_price: data.up.price, purchase_amount: (data.up.shares || 0) * (data.up.price || 0), shares: data.up.shares, order_status: 'open', purchase_time: nowIso, order_type: 'live' });
        if (data.down?.orderID) optimistic.push({ id: `temp-${Date.now()}-down`, polymarket_order_id: data.down.orderID, polymarket_event_id: event?.slug, direction: 'down', purchase_price: data.down.price, purchase_amount: (data.down.shares || 0) * (data.down.price || 0), shares: data.down.shares, order_status: 'open', purchase_time: nowIso, order_type: 'live' });
        if (optimistic.length) setOrders(prev => [...optimistic, ...prev]);
      }
      const refresh = () => { fetchOrders(); fetchOpenOrders(); if (event?.slug) fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`).then(r => r.json()).then(d => setPositions(d.positions || [])).catch(() => {}); fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {}); };
      refresh();
      setTimeout(refresh, 800); setTimeout(refresh, 2000); setTimeout(refresh, 5000); setTimeout(refresh, 10000);
    } catch (e) { setToast({ success: false, error: e.message }); } finally { setBuying(null); }
  }

  async function handleBuyThenSellBoth() {
    setBuying('buy-then-sell-both');
    try {
      const res = await fetch(`${API_BASE}/api/buy-then-sell-both`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        setToast({ success: false, error: `Invalid response (${res.status})`, type: 'buy-then-sell' });
        return;
      }
      setToast({ ...data, type: 'buy-then-sell', message: data.message || 'Buys placed. Sells will be placed when filled.' });
      const refresh = () => { fetchOrders(); fetchOpenOrders(); if (event?.slug) fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`).then(r => r.json()).then(d => setPositions(d.positions || [])).catch(() => {}); fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {}); };
      refresh();
      setTimeout(refresh, 800); setTimeout(refresh, 2000); setTimeout(refresh, 5000); setTimeout(refresh, 10000);
    } catch (e) { setToast({ success: false, error: e.message }); } finally { setBuying(null); }
  }

  async function handleSellBoth() {
    setBuying('sell-both');
    try {
      const res = await fetch(`${API_BASE}/api/sell-both`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        setToast({ success: false, error: `Invalid response (${res.status})`, type: 'sell-both' });
        return;
      }
      setToast({ ...data, type: 'sell-both' });
      const refresh = () => { fetchOrders(); fetchOpenOrders(); if (event?.slug) fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`).then(r => r.json()).then(d => setPositions(d.positions || [])).catch(() => {}); fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {}); };
      setTimeout(refresh, 2000); setTimeout(refresh, 5000); setTimeout(refresh, 10000);
    } catch (e) { setToast({ success: false, error: e.message }); } finally { setBuying(null); }
  }

  async function handleSplit() {
    setBuying('split');
    try {
      const res = await fetch(`${API_BASE}/api/split`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 150 }),
      });
      const data = await res.json();
      setToast({ ...data, type: 'split', message: data.success ? `Split $150 → 150 Up + 150 Down (tx: ${data.txHash?.slice(0,10)}...)` : data.error });
      const refresh = () => { fetchOrders(); fetchOpenOrders(); fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {}); };
      refresh(); setTimeout(refresh, 3000); setTimeout(refresh, 10000);
    } catch (e) { setToast({ success: false, error: e.message }); } finally { setBuying(null); }
  }

  async function handleCancelOrder(orderID) {
    try {
      await fetch(`${API_BASE}/api/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderID }),
      });
      fetchOpenOrders();
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  async function handleCancelAll() {
    try {
      await fetch(`${API_BASE}/api/cancel-all`, { method: 'POST' });
      setOpenOrders([]);
      fetchOpenOrders();
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  // Orders for current event; fall back to most recent event if filter yields nothing
  let eventOrders = orders;
  if (event?.slug) {
    const slugNum = (event.slug.match(/(\d{10,})/) || [])[1];
    const filtered = orders.filter(o => {
      const eid = String(o.polymarket_event_id || o.polymarket_event || '');
      return eid === event.slug || eid === slugNum;
    });
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
          <button onClick={() => setShowEventSearch(!showEventSearch)}
            className={`px-3 py-1 text-xs rounded-lg border transition-colors ${
              showEventSearch
                ? 'bg-orange-600/30 border-orange-500/50 text-orange-300'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
            }`}>
            {showEventSearch ? 'Hide Search' : 'Find Event'}
          </button>
        </div>
        <WalletBar wallet={wallet} liquidityRewards={liquidityRewards} />
      </div>

      {showEventSearch && (
        <div className="px-4 py-2 bg-gray-950 border-b border-gray-800">
          <EventSearch currentSlug={event?.slug} onClose={() => setShowEventSearch(false)} />
        </div>
      )}

      {/* Tab bar */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 flex gap-1">
        {[['trade', '⚡ Trade'], ['divergence', '📉 Divergence'], ['trades', '🔥 Live Trades'], ['mytrades', '📋 My Trades'], ['ematrades', '📊 EMA Trades']].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t ? 'border-orange-500 text-orange-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}>{label}</button>
        ))}
      </div>

      <div className={`flex-1 p-4 mx-auto w-full space-y-4 ${tab === 'divergence' || tab === 'ematrades' ? 'max-w-5xl' : 'max-w-2xl'}`}>
        {tab === 'trades' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold text-gray-200">Live Trades</h2>
              <p className="text-xs text-gray-500 mt-0.5">Copy k9&apos;s BTC Up/Down trades in real time. Select %, event time, and enable.</p>
            </div>
            <LiveBetsConfig copyFeed={copyFeed} />
          </div>
        )}
        {tab === 'divergence' && (
          <div className="space-y-4">
            {/* Auto-Scalp Toggle */}
            <div className={`rounded-xl border p-3 space-y-2 ${autoScalp.enabled ? 'border-cyan-600 bg-cyan-950/30' : 'border-gray-800 bg-gray-900/50'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-cyan-400">Auto-Scalp</span>
                  <span className="text-[10px] text-gray-500">${autoScalp.threshold} BTC move → {autoScalp.profitCents}¢ scalp ({autoScalp.shares}sh)</span>
                </div>
                <button
                  onClick={toggleAutoScalp}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    autoScalp.enabled
                      ? 'bg-cyan-600 text-white hover:bg-cyan-500'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                  }`}
                >
                  {autoScalp.enabled ? 'ON' : 'OFF'}
                </button>
              </div>
              {autoScalp.enabled && autoScalp.ref != null && (
                <div className="text-[10px] text-gray-500 font-mono">
                  Ref: ${autoScalp.ref?.toLocaleString()} | BTC: ${autoScalp.btc?.toLocaleString()} | Next trigger: ±${autoScalp.threshold}
                </div>
              )}
              {(autoScalp.sides?.up?.hedgeOrderId || autoScalp.sides?.down?.hedgeOrderId) && (
                <div className="text-[10px] text-yellow-400 font-mono">
                  {autoScalp.sides?.up?.hedgeOrderId && <div>Hedge UP: {autoScalp.sides.up.hedgeOrderId.slice(0, 12)}...</div>}
                  {autoScalp.sides?.down?.hedgeOrderId && <div>Hedge DN: {autoScalp.sides.down.hedgeOrderId.slice(0, 12)}...</div>}
                </div>
              )}
              {autoScalp.log?.length > 0 && (
                <div className="space-y-0.5">
                  {autoScalp.log.slice(0, 5).map((l, i) => (
                    <div key={i} className="text-[10px] font-mono text-gray-500">
                      {new Date(l.ts).toLocaleTimeString()} — {l.side.toUpperCase()} (BTC {l.delta >= 0 ? '+' : ''}{l.delta})
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-gray-800 pt-2 space-y-1 text-[10px] text-gray-600 leading-relaxed">
                <p>Watches Binance BTC stream. $5+ move → 1 scalp. FAK buys {autoScalp.shares}sh winning side → waits 1.5s for BTC to keep moving same direction → GTC hedge opposite side at price locking 1¢ profit.</p>
                <p>One scalp at a time — blocked until hedge fills or you cancel it. 3s cooldown after. Only 50-80¢.</p>
              </div>
            </div>
            {/* Auto-Flow Toggle */}
            <div className={`rounded-xl border p-3 space-y-2 ${autoFlow.enabled ? 'border-purple-600 bg-purple-950/30' : 'border-gray-800 bg-gray-900/50'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-purple-400">Auto-Flow</span>
                  <span className="text-[10px] text-gray-500">Smooth trend → 2¢ profit ({autoFlow.shares || 5}sh)</span>
                </div>
                <button
                  onClick={toggleAutoFlow}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    autoFlow.enabled
                      ? 'bg-purple-600 text-white hover:bg-purple-500'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                  }`}
                >
                  {autoFlow.enabled ? 'ON' : 'OFF'}
                </button>
              </div>
              {/* Live flow scores */}
              <div className="flex gap-4 text-[10px] font-mono">
                {autoFlow.upFlow && (
                  <span className={`${autoFlow.upFlow.goingUp ? 'text-green-400' : 'text-green-400/40'}`}>
                    Up: {(autoFlow.upFlow.mono * 100).toFixed(0)}% flow, {autoFlow.upFlow.moveCents.toFixed(1)}¢ {autoFlow.upFlow.goingUp ? '↑' : '↓'}, {autoFlow.upFlow.reversals}rev ({autoFlow.upFlow.ticks}t)
                  </span>
                )}
                {autoFlow.downFlow && (
                  <span className={`${!autoFlow.downFlow.goingUp ? 'text-red-400' : 'text-red-400/40'}`}>
                    Dn: {(autoFlow.downFlow.mono * 100).toFixed(0)}% flow, {autoFlow.downFlow.moveCents.toFixed(1)}¢ {autoFlow.downFlow.goingUp ? '↑' : '↓'}, {autoFlow.downFlow.reversals}rev ({autoFlow.downFlow.ticks}t)
                  </span>
                )}
                {!autoFlow.upFlow && !autoFlow.downFlow && <span className="text-gray-600">Collecting ticks...</span>}
              </div>
              {(autoFlow.sides?.up?.hedgeOrderId || autoFlow.sides?.down?.hedgeOrderId) && (
                <div className="text-[10px] text-yellow-400 font-mono">
                  {autoFlow.sides?.up?.hedgeOrderId && <div>Hedge UP: {autoFlow.sides.up.hedgeOrderId.slice(0, 12)}...</div>}
                  {autoFlow.sides?.down?.hedgeOrderId && <div>Hedge DN: {autoFlow.sides.down.hedgeOrderId.slice(0, 12)}...</div>}
                </div>
              )}
              {autoFlow.log?.length > 0 && (
                <div className="space-y-0.5">
                  {autoFlow.log.slice(0, 5).map((l, i) => (
                    <div key={i} className="text-[10px] font-mono text-gray-500">
                      {new Date(l.ts).toLocaleTimeString()} — {l.side.toUpperCase()} (flow={l.mono} move={l.move}¢ rev={l.reversals})
                      {l.buyPrice != null && (
                        <span className="text-cyan-400 ml-1">
                          → UP @{(l.buyPrice*100).toFixed(0)}¢ + DN @{(l.oppBuyPrice*100).toFixed(0)}¢ = {l.profit}¢
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-gray-800 pt-2 text-[10px] text-gray-600 leading-relaxed">
                <p>Detects smooth price drift (mostly flat ticks + slow creep). Triggers when ≥{(autoFlow.monotonicity * 100 || 85).toFixed(0)}% of ticks are flat or with-trend, ≤{((autoFlow.maxReversalPct ?? 0.20) * 100).toFixed(0)}% reversals, ≥{autoFlow.minMoveCents || 3}¢ total move over {autoFlow.windowSecs || 60}s. Same buy+sell as scalp. {autoFlow.priceMin || 30}–{autoFlow.priceMax || 70}¢ range.</p>
              </div>
            </div>
            {/* Auto-EMA Toggle */}
            <div className={`rounded-xl border p-3 space-y-2 transition-all ${
              autoEma.phase === 'pending' || autoEma.phase === 'retrying' ? 'border-orange-500 bg-orange-950/40 ring-1 ring-orange-500/50 animate-pulse' :
              autoEma.phase === 'entered' ? 'border-yellow-500 bg-yellow-950/40 ring-1 ring-yellow-500/50 animate-pulse' :
              autoEma.phase === 'hedging' || autoEma.phase === 'hedged' ? 'border-green-500 bg-green-950/30 ring-1 ring-green-500/50' :
              autoEma.enabled && Math.abs(autoEma.ema?.gap || 0) >= (autoEma.gapOpenThreshold || 5) ? 'border-cyan-500 bg-cyan-950/40 ring-1 ring-cyan-400/40' :
              autoEma.enabled ? 'border-cyan-600 bg-cyan-950/30' : 'border-gray-800 bg-gray-900/50'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-cyan-400">Auto-EMA</span>
                  <span className="text-[10px] text-gray-500">EMA gap ≥${autoEma.gapOpenThreshold || 5} → scalp 5sh (mkt-3¢)</span>
                  {autoEma.phase === 'pending' && <span className="text-[10px] font-bold text-orange-400 animate-pulse">PENDING FILL</span>}
                  {autoEma.phase === 'entered' && <span className="text-[10px] font-bold text-yellow-400 animate-pulse">ENTERED</span>}
                  {autoEma.phase === 'hedging' && <span className="text-[10px] font-bold text-green-400 animate-pulse">HEDGING</span>}
                  {autoEma.phase === 'hedged' && <span className="text-[10px] font-bold text-green-400">HEDGED</span>}
                </div>
                <button
                  onClick={toggleAutoEma}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    autoEma.enabled
                      ? 'bg-cyan-600 text-white hover:bg-cyan-500'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                  }`}
                >
                  {autoEma.enabled ? 'ON' : 'OFF'}
                </button>
              </div>
              {/* Live EMA state */}
              <div className="flex gap-3 text-[10px] font-mono flex-wrap">
                <span className="text-cyan-400">EMA12: {autoEma.ema?.e12 != null ? `$${autoEma.ema.e12.toFixed(1)}` : '—'}</span>
                <span className="text-purple-400">EMA26: {autoEma.ema?.e26 != null ? `$${autoEma.ema.e26.toFixed(1)}` : '—'}</span>
                <span className={`${(autoEma.ema?.btcMoveSinceCross || 0) >= 10 ? 'text-yellow-400' : 'text-gray-600'}`}>
                  BTC: ${(autoEma.ema?.btcMoveSinceCross || 0).toFixed(0)} since cross
                </span>
                <span className={`font-bold ${
                  Math.abs(autoEma.ema?.gap || 0) >= (autoEma.gapOpenThreshold || 5)
                    ? (autoEma.ema?.gap || 0) > 0 ? 'text-green-400' : 'text-red-400'
                    : 'text-gray-500'
                }`}>
                  Gap: ${Math.abs(autoEma.ema?.gap || 0).toFixed(1)} {(autoEma.ema?.gap || 0) > 0 ? 'UP' : (autoEma.ema?.gap || 0) < 0 ? 'DN' : ''}
                  {Math.abs(autoEma.ema?.gap || 0) >= (autoEma.gapOpenThreshold || 5) && ' OPEN'}
                  {Math.abs(autoEma.ema?.gap || 0) >= 2 && Math.abs(autoEma.ema?.gap || 0) < (autoEma.gapOpenThreshold || 5) && (autoEma.ema?.btcMoveSinceCross || 0) >= 10 && ' OPEN(BTC$' + (autoEma.ema?.btcMoveSinceCross || 0).toFixed(0) + ')'}
                </span>
                <span className={`${(autoEma.ema?.histogram || 0) > 0 ? 'text-green-400' : (autoEma.ema?.histogram || 0) < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                  Hist: {(autoEma.ema?.histogram || 0).toFixed(2)}
                </span>
              </div>
              {autoEma.phase && (
                <div className={`text-[10px] font-mono font-bold ${autoEma.phase === 'entered' ? 'text-yellow-400' : 'text-green-400'}`}>
                  {autoEma.entrySide?.toUpperCase()} @ {autoEma.entryPrice ? `${(autoEma.entryPrice * 100).toFixed(0)}¢` : '—'}
                  {autoEma.peakGap > 0 && ` | peakGap: $${autoEma.peakGap.toFixed(1)}`}
                  {autoEma.btcPeak != null && ` | btcPeak: $${autoEma.btcPeak.toFixed(0)}`}
                  {autoEma.phase === 'entered' && ` | hedge on BTC reversal ≥$5`}
                </div>
              )}
              {autoEma.log?.length > 0 && (
                <div className="space-y-1">
                  {autoEma.log.slice(0, 5).map((l, i) => (
                    <div key={i} className={`text-[10px] font-mono rounded px-1.5 py-0.5 ${
                      l.result === 'filled' || l.result === 'tp_filled' ? 'bg-green-950/50 text-green-400' :
                      l.result === 'hedged' ? 'bg-yellow-950/50 text-yellow-400' :
                      l.result === 'trend_faded' || l.result === 'max_retries' ? 'bg-red-950/50 text-red-400' :
                      l.result === 'entered' ? 'bg-cyan-950/50 text-cyan-400' :
                      'bg-gray-900/50 text-gray-500'
                    }`}>
                      <span>{new Date(l.ts).toLocaleTimeString()}</span>
                      <span className="ml-1 font-bold">{l.side?.toUpperCase()}</span>
                      <span className="ml-1">gap=${Math.abs(l.triggerGap || l.gap || 0).toFixed(1)}</span>
                      {l.entryPrice != null && <span className="ml-1 text-cyan-300">buy@{(l.entryPrice*100).toFixed(0)}¢</span>}
                      {l.tpPrice != null && <span className="ml-1 text-purple-300">tp@{(l.tpPrice*100).toFixed(0)}¢</span>}
                      {l.peakGap > 0 && <span className="ml-1">peak=${l.peakGap.toFixed(1)}</span>}
                      {l.hedgePrice != null && <span className="ml-1 text-yellow-300">hedge@{(l.hedgePrice*100).toFixed(0)}¢</span>}
                      {l.hedgeReason && <span className="ml-1 text-gray-400">({l.hedgeReason})</span>}
                      {l.profit != null && <span className={`ml-1 font-bold ${l.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{l.profit >= 0 ? '+' : ''}{l.profit}¢</span>}
                      <span className={`ml-1 ${
                        l.result === 'filled' || l.result === 'tp_filled' ? 'text-green-300' :
                        l.result === 'trend_faded' || l.result === 'max_retries' ? 'text-red-300' : ''
                      }`}>{l.result}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-gray-800 pt-2 text-[10px] text-gray-600 leading-relaxed">
                <p>Gap ≥${autoEma.gapOpenThreshold || 5} & widening → buy winning side at mkt-3¢. Gap &lt;${autoEma.gapOpenThreshold || 5} → hedge opposite at mkt-3¢. Always 5sh. {autoEma.priceMin || 25}–{autoEma.priceMax || 85}¢. Timeout: {(autoEma.maxHedgeWaitMs || 30000) / 1000}s.</p>
              </div>
            </div>
            <PriceDivergence key={event?.slug} prices={prices} btc={btc} binanceBtc={binanceBtc} event={event} autoEmaLog={autoEma.log || []} />
          </div>
        )}
        {tab === 'mytrades' && <MyTrades />}
        {tab === 'ematrades' && <EmaTradeLog />}
        {tab === 'k9' && (
          <>
            <LiveBetsConfig copyFeed={copyFeed} />
            <K9Trades />
          </>
        )}
        {tab === 'sim' && <SimDashboard />}
        {tab === 'prices' && <PriceTracker key={event?.slug} btc={btc} binanceBtc={binanceBtc} prices={prices} event={event} />}
        {tab === 'trade' && <>
        {/* Sim shortcut banner */}
        <button
          onClick={() => setTab('sim')}
          className="w-full flex items-center justify-between bg-gray-900 border border-orange-900/50 hover:border-orange-500/50 rounded-lg px-4 py-3 transition-colors group"
        >
          <div className="flex items-center gap-3">
            <span className="text-orange-400 text-lg">📊</span>
            <div className="text-left">
              <div className="text-sm font-medium text-gray-200">k9 Simulator</div>
              <div className="text-xs text-gray-500">Live sim of what we'd trade at 1% of k9</div>
            </div>
          </div>
          <span className="text-gray-600 group-hover:text-orange-400 transition-colors">→</span>
        </button>
        </>}
        {tab === 'trade' && <>
        {/* Event */}
        <EventHeader event={event} />

        {/* BTC Price Bar */}
        <BTCBar btc={btc} />

        {/* Compact price tracker link */}
        <button
          onClick={() => setTab('prices')}
          className="w-full flex items-center justify-between bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-lg px-4 py-2 transition-colors group text-xs font-mono"
        >
          <span className="text-gray-500">BTC <span className="text-white font-bold">${btc.current ? btc.current.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</span></span>
          {btc.start != null && btc.current != null && (
            <span className={`${btc.current >= btc.start ? 'text-green-400' : 'text-red-400'}`}>
              {btc.current >= btc.start ? '+' : ''}{(btc.current - btc.start).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
          <span className="text-gray-600 group-hover:text-orange-400 transition-colors">📈 Price History →</span>
        </button>

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
            onRewardsBuy={handleRewardsBuy}
            onRewardsSell={handleRewardsSell}
            onSuperRewards={handleSuperRewards}
            onSuperSell={handleSuperSell}
            onWhaleStyleBuy={handleWhaleStyleBuy}
            onSell={handleSell}
            onSellAll={handleSellAll}
            holdings={holdings}
            tokenId={prices.tokenUp}
            expectedROI={expectedROI}
          />
          <BuyPanel
            side="down"
            price={prices.downPrice}
            amounts={AMOUNTS}
            buying={buying}
            onBuy={handleBuy}
            onRewardsBuy={handleRewardsBuy}
            onRewardsSell={handleRewardsSell}
            onSuperRewards={handleSuperRewards}
            onSuperSell={handleSuperSell}
            onWhaleStyleBuy={handleWhaleStyleBuy}
            onSell={handleSell}
            onSellAll={handleSellAll}
            holdings={holdings}
            tokenId={prices.tokenDown}
            expectedROI={expectedROI}
          />
        </div>

        {/* Buy + Sell: buy at X, sell at X+profit */}
        <div className="rounded-xl p-3 border bg-gray-800/40 border-gray-700/40">
          <div className="text-xs font-bold text-blue-300 mb-2">Buy + Sell (+{buySell.profit}¢)</div>
          <div className="flex gap-2 items-center mb-2">
            <input
              type="number"
              placeholder="Price ¢"
              value={buySell.price}
              onChange={e => setBuySell(s => ({ ...s, price: e.target.value }))}
              className="w-16 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white"
            />
            <input
              type="number"
              value={buySell.shares}
              onChange={e => setBuySell(s => ({ ...s, shares: Math.max(1, parseInt(e.target.value) || 1) }))}
              className="w-12 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white"
            />
            <span className="text-[10px] text-gray-400">sh</span>
            <input
              type="number"
              value={buySell.profit}
              onChange={e => setBuySell(s => ({ ...s, profit: Math.max(1, parseInt(e.target.value) || 1) }))}
              className="w-10 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white"
            />
            <span className="text-[10px] text-gray-400">¢ profit</span>
          </div>
          <div className="flex gap-2 text-[10px]">
            {buySell.price && <span className="text-gray-400">Buy@{buySell.price}¢ → Sell@{(parseFloat(buySell.price||0)+buySell.profit).toFixed(0)}¢</span>}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <button
              disabled={buying?.startsWith('bs-') || !buySell.price}
              onClick={() => handleBuySell('up')}
              className="py-1.5 rounded text-xs font-bold bg-green-900/40 hover:bg-green-800/40 border border-green-600/30 text-green-300 disabled:opacity-30"
            >
              {buying === 'bs-up' ? '...' : 'UP'}
            </button>
            <button
              disabled={buying?.startsWith('bs-') || !buySell.price}
              onClick={() => handleBuySell('down')}
              className="py-1.5 rounded text-xs font-bold bg-red-900/40 hover:bg-red-800/40 border border-red-600/30 text-red-300 disabled:opacity-30"
            >
              {buying === 'bs-down' ? '...' : 'DOWN'}
            </button>
          </div>
        </div>

        {/* Auto-Lost Strategy: buy@2¢ sell@7¢ on each event */}
        <div className={`rounded-xl p-3 border ${autoLost.enabled ? 'bg-purple-900/30 border-purple-500/50' : 'bg-gray-800/40 border-gray-700/40'}`}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-purple-300">Auto-Lost (buy@{(autoLost.buyPrice*100).toFixed(0)}¢ sell@{(autoLost.sellPrice*100).toFixed(0)}¢)</span>
            <button
              onClick={toggleAutoLost}
              className={`px-3 py-1 rounded text-xs font-bold ${autoLost.enabled ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-400'}`}
            >
              {autoLost.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] text-gray-400">Side:</span>
            {['up', 'down', 'both'].map(s => (
              <button
                key={s}
                onClick={() => setAutoLostSide(s)}
                className={`px-2 py-0.5 rounded text-[10px] font-bold ${autoLost.side === s
                  ? (s === 'up' ? 'bg-green-700 text-green-200' : s === 'down' ? 'bg-red-700 text-red-200' : 'bg-blue-700 text-blue-200')
                  : 'bg-gray-700/50 text-gray-500'}`}
              >
                {s.toUpperCase()}
              </button>
            ))}
            <span className="text-[10px] text-gray-400 ml-auto">{autoLost.shares}sh</span>
          </div>
          {/* Manual fire buttons */}
          <div className="grid grid-cols-2 gap-2 mb-1">
            <button
              disabled={buying?.startsWith('lost-')}
              onClick={() => handleLostScalp('up')}
              className="py-1 rounded text-[10px] font-bold bg-green-900/40 hover:bg-green-800/40 border border-green-600/30 text-green-400 disabled:opacity-30"
            >
              {buying === 'lost-up' ? '...' : 'Fire UP now'}
            </button>
            <button
              disabled={buying?.startsWith('lost-')}
              onClick={() => handleLostScalp('down')}
              className="py-1 rounded text-[10px] font-bold bg-red-900/40 hover:bg-red-800/40 border border-red-600/30 text-red-400 disabled:opacity-30"
            >
              {buying === 'lost-down' ? '...' : 'Fire DN now'}
            </button>
          </div>
          {autoLost.log?.length > 0 && (
            <div className="text-[9px] text-gray-500 mt-1">
              {autoLost.log.slice(0, 3).map((l, i) => (
                <div key={i}>{l.side?.toUpperCase()} {l.error ? `❌ ${l.error}` : `✓ buy=${l.buyId?.slice(0,6)} sell=${l.sellId?.slice(0,6)}`}</div>
              ))}
            </div>
          )}
        </div>

        {/* Buy/Sell Both */}
        <div className="grid grid-cols-2 gap-3">
          <button
            disabled={buying === 'buy-both' || !prices.upPrice || !prices.downPrice}
            onClick={handleBuyBoth}
            className={`py-2 rounded-lg text-sm font-bold transition-all ${
              buying === 'buy-both' ? 'opacity-50 cursor-wait' : ''
            } bg-blue-700/40 hover:bg-blue-600/40 border border-blue-500/40 text-blue-300 disabled:opacity-30`}
          >
            {buying === 'buy-both' ? '...' : 'Buy Both 10 (@ mid)'}
          </button>
          <button
            disabled={buying === 'sell-both' || !prices.upPrice || !prices.downPrice}
            onClick={handleSellBoth}
            className={`py-2 rounded-lg text-sm font-bold transition-all ${
              buying === 'sell-both' ? 'opacity-50 cursor-wait' : ''
            } bg-purple-700/40 hover:bg-purple-600/40 border border-purple-500/40 text-purple-300 disabled:opacity-30`}
          >
            {buying === 'sell-both' ? '...' : 'Sell Both 10 (+1¢)'}
          </button>
          <button
            disabled={buying === 'buy-then-sell-both' || !prices.upPrice || !prices.downPrice}
            onClick={handleBuyThenSellBoth}
            className={`col-span-2 py-2 rounded-lg text-sm font-bold transition-all ${
              buying === 'buy-then-sell-both' ? 'opacity-50 cursor-wait' : ''
            } bg-cyan-700/40 hover:bg-cyan-600/40 border border-cyan-500/40 text-cyan-300 disabled:opacity-30`}
          >
            {buying === 'buy-then-sell-both' ? '...' : 'Buy 10 Both @ mid → Sell @ p+1¢ when filled'}
          </button>
          <button
            disabled={buying === 'split' || !event}
            onClick={handleSplit}
            className={`col-span-2 py-2 rounded-lg text-sm font-bold transition-all ${
              buying === 'split' ? 'opacity-50 cursor-wait' : ''
            } bg-orange-700/40 hover:bg-orange-600/40 border border-orange-500/40 text-orange-300 disabled:opacity-30`}
          >
            {buying === 'split' ? 'Splitting...' : 'Split $150 → 150 Up + 150 Down'}
          </button>
        </div>

        {/* Pending Sells (limit sells resting on book) */}
        {(() => {
          const pendingSells = openOrders.filter(o => {
            const aid = o.asset_id ?? o.asset;
            return o.side === 'SELL' && (aid === prices.tokenUp || aid === prices.tokenDown);
          });
          return pendingSells.length > 0 ? (
            <div className="rounded-xl border border-yellow-800/50 bg-yellow-950/20 p-4 space-y-2">
              <h3 className="font-bold text-sm text-yellow-400">Pending Sells ({pendingSells.length})</h3>
              <div className="space-y-1">
                {pendingSells.map(o => {
                  const aid = o.asset_id ?? o.asset;
                  const side = aid === prices.tokenUp ? 'up' : 'down';
                  const curPrice = side === 'up' ? prices.upPrice : prices.downPrice;
                  const targetPrice = parseFloat(o.price || 0);
                  const total = parseFloat(o.original_size || 0);
                  const filled = parseFloat(o.size_matched || 0);
                  const remaining = total - filled;
                  const diff = curPrice != null ? (targetPrice - curPrice) : null;
                  const sideColor = side === 'up' ? 'text-green-400' : 'text-red-400';
                  return (
                    <div key={o.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 font-mono flex-wrap">
                        <span className="font-bold text-yellow-400">SELL</span>
                        <span className={`font-bold ${sideColor}`}>{side.toUpperCase()}</span>
                        <span className="text-gray-300">{(targetPrice * 100).toFixed(1)}¢</span>
                        <span className="text-gray-500">{remaining.toFixed(1)} sh</span>
                        {diff != null && (
                          <span className={`text-[10px] ${diff <= 0 ? 'text-green-400' : 'text-orange-400'}`}>
                            {diff <= 0 ? 'READY' : `${(diff * 100).toFixed(1)}¢ away`}
                          </span>
                        )}
                      </div>
                      <button onClick={() => handleCancelOrder(o.id)}
                        className="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 transition-colors">
                        Cancel
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null;
        })()}

        {/* Open Orders */}
        {openOrders.length > 0 && (
          <div className="rounded-xl border border-blue-800/50 bg-blue-950/20 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-sm text-blue-400">Open Orders ({openOrders.length})</h3>
              <button onClick={handleCancelAll}
                className="px-2 py-1 rounded text-[10px] font-bold bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 transition-colors">
                Cancel All
              </button>
            </div>
            <div className="space-y-1">
              {openOrders.map(o => {
                const assetId = o.asset_id ?? o.asset;
                const oSide = assetId === prices.tokenUp ? 'UP' : assetId === prices.tokenDown ? 'DN' : /up|yes/i.test(o.outcome || '') ? 'UP' : 'DN';
                const isSell = o.side === 'SELL';
                const sideColor = oSide === 'UP' ? 'text-green-400' : 'text-red-400';
                const filled = parseFloat(o.size_matched || 0);
                const total = parseFloat(o.original_size || 0);
                return (
                  <div key={o.id} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 font-mono">
                      <span className={`font-bold ${isSell ? 'text-yellow-400' : sideColor}`}>{isSell ? 'SELL' : 'BUY'}</span>
                      <span className={`font-bold ${sideColor}`}>{oSide}</span>
                      <span className="text-gray-300">{(parseFloat(o.price) * 100).toFixed(1)}¢</span>
                      <span className="text-gray-500">{total.toFixed(1)} sh</span>
                      {filled > 0 && <span className="text-blue-400">({filled.toFixed(1)} filled)</span>}
                    </div>
                    <button onClick={() => handleCancelOrder(o.id)}
                      className="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 transition-colors">
                      Cancel
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Positions — Polymarket API when available, else derive from orders */}
        <Positions
          positions={positions}
          eventSlug={event?.slug}
          fallbackOrders={eventOrders}
          prices={prices}
          onSell={handleSell}
          selling={buying}
        />

        {/* Orders */}
        <OrderHistory orders={eventOrders} prices={prices} />

        {/* Toast */}
        <OrderToast toast={toast} onDismiss={() => setToast(null)} />
        </>}
      </div>
    </div>
  );
}
